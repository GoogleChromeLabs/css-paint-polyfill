/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Realm } from './realm';
import { defineProperty, fetchText } from './util';

let paintWorklet;

let CSS = window.CSS;
if (!CSS) window.CSS = CSS = {};

if (!CSS.supports) CSS.supports = function s(property, value) {
	if (property == 'paint') return true;
	if (value) {
		const el = styleIsolationFrame.contentDocument.body;
		el.style.cssText = property + ':' + value;
		return el.style.cssText.length > 0;
	}
	let tokenizer = /(^|not|(or)|(and))\s*\(\s*(.+?)\s*:(.+?)\)\s*|(.)/gi,
		comparison, v, t, n;
	// [, not, or, and, key, value, unknown]
	while ((t = tokenizer.exec(property))) {
		if (t[6]) return false;
		n = s(t[4], t[5]);
		v = t[2] ? (v || n) : t[3] ? (v && n) : (comparison = !t[1], n);
	}
	return v == comparison;
};

if (!CSS.escape) CSS.escape = s => s.replace(/([^\w-])/g,'\\$1');

/** @type {{ [name: string]: { name: string, syntax: string, inherits: boolean, initialValue: string }} } */
const CSS_PROPERTIES = {};
if (!CSS.registerProperty) CSS.registerProperty = function (def) {
	CSS_PROPERTIES[def.name] = def;
};

// Minimal poorlyfill for CSS properties+values
function CSSUnitValue(value, unit) {
	const num = parseFloat(value);
	this.value = isNaN(num) ? value : num;
	this.unit = unit;
}
CSSUnitValue.prototype.toString = function() {
	return this.value + (this.unit == 'number' ? '' : this.unit);
};
CSSUnitValue.prototype.valueOf = function() {
	return this.value;
};

'Hz Q ch cm deg dpcm dpi ddpx em ex fr grad in kHz mm ms number pc percent pt px rad rem s turn vh vmax vmin vw'.split(' ').forEach(unit => {
	if (!CSS[unit]) {
		CSS[unit] = v => new CSSUnitValue(v, unit);
	}
});

// Matches CSS properties that can accept a paint() value:
const IMAGE_CSS_PROPERTIES = /(background|mask|cursor|-image|-source)/;

const supportsPaintWorklet = !!CSS.paintWorklet;
if (!supportsPaintWorklet) {
	paintWorklet = new PaintWorklet();
	defineProperty(CSS, 'paintWorklet', {
		enumerable: true,
		configurable: true,
		get: () => paintWorklet
	});
}

const GLOBAL_ID = 'css-paint-polyfill';

let root = document.createElement(GLOBAL_ID);
if (!supportsPaintWorklet) {
	document.documentElement.appendChild(root);
}

let styleIsolationFrame = document.createElement('iframe');
styleIsolationFrame.style.cssText = 'position:absolute; left:0; top:-999px; width:1px; height:1px;';
root.appendChild(styleIsolationFrame);

let overridesStylesheet = document.createElement('style');
overridesStylesheet.id = GLOBAL_ID;
overridesStylesheet.$$isPaint = true;
root.appendChild(overridesStylesheet);
let overrideStyles = overridesStylesheet.sheet;
let testStyles = root.style;

// when `true`, interception of styles is disabled
let bypassStyleHooks = false;

const EMPTY_ARRAY = [];
const HAS_PAINT = /(paint\(|-moz-element\(#paint-|-webkit-canvas\(paint-|[('"]blob:[^'"#]+#paint=|[('"]data:image\/paint-)/;
const USE_CSS_CANVAS_CONTEXT = 'getCSSCanvasContext' in document;
const USE_CSS_ELEMENT = (testStyles.backgroundImage = `-moz-element(#${GLOBAL_ID})`) === testStyles.backgroundImage;
const HAS_PROMISE = (typeof Promise === 'function');
testStyles.cssText = 'display:none !important;';

let defer = window.requestAnimationFrame || setTimeout;
let getDevicePixelRatio = () => window.devicePixelRatio || 1;

let painters = {};
let trackedRules = {};
let styleSheetCounter = 0;

function registerPaint(name, Painter, worklet) {
	// if (painters[name]!=null) throw Error(`registerPaint(${name}): name already registered`);
	painters[name] = {
		worklet,
		Painter,
		properties: Painter.inputProperties ? [].slice.call(Painter.inputProperties) : [],
		bit: 0,
		instances: []
	};
	let query = '';
	for (let i=overrideStyles.cssRules.length; i--; ) {
		const rule = overrideStyles.cssRules[i];
		if (rule.style.cssText.indexOf('-' + name) !== -1) {
			query += rule.selectorText;
		}
	}
	if (query) processItem(query, true);
}

function getPainter(name) {
	let painter = painters[name];
	// if (painter == null) throw Error(`No paint defined for "${name}"`);
	return painter;
}

function getPainterInstance(painter) {
	// Alternate between two instances.
	// @TODO should alternate between two *worklets*. Class instances are meaningless for perf.
	let inst = painter.bit ^= 1;
	return painter.instances[inst] || (painter.instances[inst] = new painter.Painter());
}

function paintRuleWalker(rule, context) {
	let css = rule.cssText;
	const hasPaint = HAS_PAINT.test(css);

	if (context.isNew === true && hasPaint) {
		if (css !== (css = escapePaintRules(css))) {
			rule = replaceRule(rule, css);
		}
	}

	// Hello future self!
	// This eager exit avoids tracking unpainted rules.
	// That seems reasonable, but it wasn't in place in 3.0...
	// Perhaps I'm missing something, if so, I apologize.
	if (!hasPaint) return;

	let selector = rule.selectorText,
		cssText = getCssText(rule.style),
		index, key, cached;

	if (context.counters[selector] == null) {
		index = context.counters[selector] = 1;
	}
	else {
		index = ++context.counters[selector];
	}
	key = 'sheet' + context.sheetId + '\n' + selector + '\n' + index;
	if (trackedRules[key] != null) {
		cached = trackedRules[key];
		if (cached.selector === selector) {
			cached.rule = rule;
			if (cached.cssText !== cssText) {
				context.toProcess.push(cached);
			}
			return;
		}
		context.toRemove.push(cached);
	}
	else {
		cached = trackedRules[key] = { key, selector, cssText, properties: {}, rule };
		context.toProcess.push(cached.selector);
	}
}

function walk(node, iterator) {
	if ('ownerSVGElement' in node) return;
	iterator(node);
	let child = node.firstElementChild;
	while (child) {
		walk(child, iterator);
		child = child.nextElementSibling;
	}
}

function update() {
	let sheets = [].slice.call(document.styleSheets),
		context = {
			toProcess: [],
			toRemove: [],
			counters: {},
			isNew: false,
			sheetId: null,
			// this property is unused - it's assigned to in order to prevent Terser from removing the try/catch on L220
			rules: null
		},
		invalidateAll;

	for (let i=0; i<sheets.length; i++) {
		let node = sheets[i].ownerNode;
		if (node.$$isPaint) continue;

		// Check that we can access the sheet.
		// (assigning to `context.rules` prevents Terser from removing the block)
		try { context.rules = node.sheet.cssRules; }
		catch (e) { continue; }

		context.sheetId = node.$$paintid;
		context.isNew = context.sheetId == null;
		if (context.isNew) {
			context.sheetId = node.$$paintid = ++styleSheetCounter;
			// allow processing to defer parse
			if (processNewSheet(node)===false) {
				continue;
			}
			invalidateAll = true;
		}
		walkStyles(node.sheet, paintRuleWalker, context);
	}

	for (let i = context.toRemove.length; i--; ) {
		// @todo cleanup?
		delete trackedRules[context.toRemove[i].key];
	}

	if (context.toProcess.length>0) {
		processItem(context.toProcess.join(', '));
	}

	// If a new stylesheet is injected, invalidate all geometry and paint output.
	if (invalidateAll) {
		processItem('[data-css-paint]', true);
	}
}

function walkStyles(sheet, iterator, context) {
	let stack = [[0, sheet.cssRules]],
		current = stack[0],
		rules = current[1];
	if (rules) {
		for (let j=0; stack.length>0; j++) {
			if (j>=rules.length) {
				stack.pop();
				let len = stack.length;
				if (len > 0) {
					current = stack[len - 1];
					rules = current[1];
					j = current[0];
				}
				continue;
			}
			current[0] = j;
			let rule = rules[j];
			// process @import rules (requires re-fetching)
			if (rule.type === 3) {
				if (rule.$$isPaint) continue;
				const mq = rule.media && rule.media.mediaText;
				if (mq && !self.matchMedia(mq).matches) continue;
				// don't refetch google font stylesheets
				if (/ts\.g.{7}is\.com\/css/.test(rule.href)) continue;
				rule.$$isPaint = true;
				fetchText(rule.href, processRemoteSheet);
				continue;
			}
			if (rule.type !== 1) {
				if (rule.cssRules && rule.cssRules.length>0) {
					stack.push([0, rule.cssRules]);
				}
				continue;
			}
			let r = iterator(rule, context);
			if (r!==undefined) context = r;
		}
	}
	return context;
}

function parseCss(css) {
	let parent = styleIsolationFrame.contentDocument.body;
	let style = document.createElement('style');
	style.media = 'print';
	style.$$paintid = ++styleSheetCounter;
	style.appendChild(document.createTextNode(css));
	parent.appendChild(style);
	style.sheet.remove = () => parent.removeChild(style);
	return style.sheet;
}

function replaceRule(rule, newRule) {
	let sheet = rule.parentStyleSheet,
		parent = rule.parentRule,
		rules = (parent || sheet).cssRules,
		index = rules.length - 1;
	for (let i=0; i<=index; i++) {
		if (rules[i] === rule) {
			(parent || sheet).deleteRule(i);
			index = i;
			break;
		}
	}
	if (newRule!=null) {
		if (parent) {
			let index = parent.appendRule(newRule);
			return parent.cssRules[index];
		}
		sheet.insertRule(newRule, index);
		return sheet.cssRules[index];
	}
}

// Replace paint(id) with url(data:image/paint-id) for a newly detected stylesheet
function processNewSheet(node) {
	if (node.$$isPaint) return;

	if (node.href) {
		fetchText(node.href, processRemoteSheet);
		return false;
	}

	for (let i=node.childNodes.length; i--; ) {
		let css = node.childNodes[i].nodeValue;
		let escaped = escapePaintRules(css);
		if (escaped !== css) {
			node.childNodes[i].nodeValue = escaped;
		}
	}
}

function processRemoteSheet(css) {
	let sheet = parseCss(escapePaintRules(css));

	// In Firefox, accessing .cssRules in a stylesheet with pending @import rules fails.
	// Try to wait for them to resolve, otherwise try again after a long delay.
	try {
		sheet._ = sheet.cssRules.length;
	}
	catch (e) {
		let next = () => {
			if (sheet) processRemoteSheetRules(sheet);
			sheet = null;
			clearTimeout(timer);
		};
		sheet.ownerNode.onload = sheet.ownerNode.onerror = next;
		let timer = setTimeout(next, 5000);
		return;
	}

	processRemoteSheetRules(sheet);
}

function processRemoteSheetRules(sheet) {
	let newSheet = '';
	walkStyles(sheet, (rule) => {
		if (rule.type !== 1) return;
		let css = '';
		for (let i=0; i<rule.style.length; i++) {
			const prop = rule.style.item(i);
			const value = rule.style.getPropertyValue(prop);
			if (HAS_PAINT.test(value)) {
				css = `${prop}: ${value}${rule.style.getPropertyPriority(prop)};`;
			}
		}
		if (!css) return;
		css = `${rule.selectorText}{${css}}`;
		// wrap the StyleRule in any parent ConditionalRules (media queries, etc):
		let r = rule;
		while ((r = r.parentRule)) {
			css = `${r.cssText.match(/^[\s\S]+?\{/)[0]}${css}}`;
		}
		newSheet += css;
	});

	sheet.remove();

	if (newSheet) {
		const pageStyles = document.createElement('style');
		// pageStyles.$$paintid = styleSheetCounter;
		pageStyles.appendChild(document.createTextNode(newSheet));
		root.appendChild(pageStyles);
		update();
	}
}

function escapePaintRules(css) {
	return css.replace(/( |;|,|\b)paint\s*\(\s*(['"]?)(.+?)\2\s*\)( |;|,|!|\b|$)/g, '$1url(data:image/paint-$3,=)$4');
}

let updateQueue = [];
function queueUpdate(element, forceInvalidate) {
	if (forceInvalidate) {
		element.$$paintObservedProperties = null;
		if (element.$$paintGeometry && !element.$$paintGeometry.live) {
			element.$$paintGeometry = null;
		}
	}
	if (element.$$paintPending===true) return;
	element.$$paintPending = true;
	if (updateQueue.indexOf(element) === -1 && updateQueue.push(element) === 1) {
		defer(processUpdateQueue);
	}
}
function processUpdateQueue() {
	// any added stylesheets get processed first before flushing queued elements
	let shouldUpdate;
	for (let i=0; i<updateQueue.length; i++) {
		if (updateQueue[i] && updateQueue[i].localName === 'style') {
			shouldUpdate = true;
			updateQueue[i] = null;
		}
	}
	if (shouldUpdate) {
		defer(processUpdateQueue);
		update();
		return;
	}
	// if we need to disable the override sheet, only do it once:
	const disable = updateQueue.length && updateQueue.some(el => el && el.$$needsOverrides === true);
	if (disable) disableOverrides();
	while (updateQueue.length) {
		let el = updateQueue.pop();
		if (el) maybeUpdateElement(el);
	}
	if (disable) enableOverrides();
}

function processItem(selector, forceInvalidate) {
	try {
		let sel = document.querySelectorAll(selector);
		for (let i=0; i<sel.length; i++) queueUpdate(sel[i], forceInvalidate);
	}
	catch (e) {}
}

function loadImages(images, callback, args) {
	let count = images.length;
	let onload = () => {
		if (--count) return;
		callback.apply(null, args || EMPTY_ARRAY);
	};
	for (let i=0; i<images.length; i++) {
		let img = new Image();
		img.onload = onload;
		img.onerror = onerror;
		img.src = images[i];
	}
}

function ensurePaintId(element) {
	let paintId = element.$$paintId;
	if (paintId==null) {
		paintId = element.$$paintId = ++idCounter;
	}
	return paintId;
}

function getPaintRuleForElement(element) {
	let paintRule = element.$$paintRule,
		paintId = ensurePaintId(element);
	// Fix cloned DOM trees which can have incorrect data-css-paint attributes:
	if (Number(element.getAttribute('data-css-paint')) !== paintId) {
		element.setAttribute('data-css-paint', paintId);
	}
	if (paintRule==null) {
		let index = overrideStyles.insertRule(`[data-css-paint="${paintId}"] {}`, overrideStyles.cssRules.length);
		paintRule = element.$$paintRule = overrideStyles.cssRules[index];
	}
	return paintRule;
}

function getCssText(style) {
	let text = style.cssText;
	if (text) return text;
	text = '';
	for (let i=0, prop; i<style.length; i++) {
		prop = style[i];
		if (i!==0) text += ' ';
		text += prop;
		text += ':';
		text += style.getPropertyValue(prop);
		text += ';';
	}
	return text;
}

function maybeUpdateElement(element) {
	let computed = getComputedStyle(element);

	if (element.$$paintObservedProperties && !element.$$needsOverrides) {
		for (let i=0; i<element.$$paintObservedProperties.length; i++) {
			let prop = element.$$paintObservedProperties[i];
			if (computed.getPropertyValue(prop).trim() !== element.$$paintedPropertyValues[prop]) {
				updateElement(element, computed);
				break;
			}
		}
	}
	else if (element.$$paintId || HAS_PAINT.test(getCssText(computed))) {
		updateElement(element, computed);
	}
	else {
		// first time we've seen this element, and it has a style attribute with unparsed paint rules.
		const styleAttr = element.getAttribute('style');
		if (HAS_PAINT.test(styleAttr)) {
			element.style.cssText = styleAttr.replace(/;\s*$/, '') + '; ' + element.style.cssText;
			updateElement(element);
		}
	}

	element.$$paintPending = false;
}

// Invalidate any cached geometry and enqueue an update
function invalidateElementGeometry(element) {
	if (element.$$paintGeometry && !element.$$paintGeometry.live) {
		element.$$paintGeometry = null;
	}
	queueUpdate(element);
}

let currentProperties, currentElement, propertyContainerCache;
const propertiesContainer = {
	// .get() is used by worklets
	get(name) {
		const def = CSS_PROPERTIES[name];
		let v = def && def.inherits === false ? currentElement.style.getPropertyValue(name) : propertiesContainer.getRaw(name);
		if (v == null && def) v = def.initialValue;
		else if (def && def.syntax) {
			const s = def.syntax.replace(/[<>\s]/g, '');
			if (typeof CSS[s] === 'function') v = CSS[s](v);
		}
		// Safari returns whitespace around values:
		if (typeof v === 'string') v = v.trim();
		return v;
	},
	getRaw(name) {
		if (name in propertyContainerCache) return propertyContainerCache[name];
		let v = currentProperties.getPropertyValue(name);
		// Safari returns whitespace around values:
		if (typeof v === 'string') v = v.trim();
		return propertyContainerCache[name] = v;
	}
};

// Get element geometry, relying on cached values if possible.
function getElementGeometry(element) {
	return element.$$paintGeometry || (element.$$paintGeometry = {
		width: element.clientWidth,
		height: element.clientHeight,
		live: false
	});
}

const resizeObserver = window.ResizeObserver && new window.ResizeObserver((entries) => {
	for (let i=0; i<entries.length; i++) {
		const entry = entries[i];
		let geom = entry.target.$$paintGeometry;
		if (geom) geom.live = true;
		else geom = entry.target.$$paintGeometry = { width: 0, height: 0, live: true };
		let bbox = entry.borderBoxSize;
		// Firefox returns a single borderBoxSize object, Chrome returns an Array of them:
		if (bbox && bbox.length) bbox = bbox[0];
		if (bbox) {
			geom.width = bbox.inlineSize | 0;
			geom.height = bbox.blockSize | 0;
		}
		else {
			// contentRect is the content box, so we add padding to get border-box:
			const computed = getComputedStyle(entry.target);
			const paddingX = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight);
			const paddingY = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
			geom.width = Math.round(((entry.contentRect.right - entry.contentRect.left) || entry.contentRect.width) + paddingX);
			geom.height = Math.round(((entry.contentRect.bottom - entry.contentRect.top) || entry.contentRect.height) + paddingY);
		}
		queueUpdate(entry.target, true);
	}
});
function observeResize(element) {
	if (resizeObserver && !element.$$paintGeometry.live) {
		element.$$paintGeometry.live = true;
		resizeObserver.observe(element);
	}
}

let idCounter = 0;
function updateElement(element, computedStyle) {
	if (element.$$needsOverrides === true) disableOverrides();
	let style = currentProperties = computedStyle==null ? getComputedStyle(element) : computedStyle;
	currentElement = element;
	// element.$$paintGeom = style;
	propertyContainerCache = {};
	let paintRule;
	let observedProperties = [];

	element.$$paintPending = false;

	// @TODO get computed styles and precompute geometry in a rAF after first paint, then re-use w/ invalidation
	let elementGeometry = getElementGeometry(element);
	observeResize(element);
	elementGeometry = { width: elementGeometry.width, height: elementGeometry.height };

	let dpr = getDevicePixelRatio();

	let paintedProperties = element.$$paintedProperties;

	for (let i=0; i<style.length; i++) {
		let property = style[i],
			value = propertiesContainer.getRaw(property),
			// I am sorry
			reg = /(,|\b|^)(?:url\((['"]?))?((?:-moz-element\(#|-webkit-canvas\()paint-\d+-([^;,]+)|(?:data:image\/paint-|blob:[^'"#]+#paint=)([^"';, ]+)(?:[;,].*?)?)\2\)(;|,|\s|\b|$)/g,
			newValue = '',
			index = 0,
			urls = [],
			hasChanged = false,
			hasPaints = false,
			paintId,
			token,
			disableScaling = false,
			geom = elementGeometry;
		
		if (!IMAGE_CSS_PROPERTIES.test(property)) {
			continue;
		}

		// Ignore unnecessarily aliased vendor-prefixed properties:
		if (property === '-webkit-border-image') continue;

		// Support CSS Border Images
		// NOTE: Safari cannot handle DPI-scaled border-image:-webkit-canvas(), so we disable HiDPI.
		if (/border-image/.test(property)) {
			let w = geom.width;
			let h = geom.height;

			const slice = parseCssDimensions(
				propertiesContainer
					.getRaw('border-image-slice')
					.replace(/\sfill/, '')
					.split(' ')
			);
			const borderWidth = parseCssDimensions(propertiesContainer.getRaw('border-width').split(' '));
			const outset = parseCssDimensions(propertiesContainer.getRaw('border-image-outset').split(' '));

			// Add the outside to dimensions, which is a multiple/percentage of each border width:
			// Note: this must first omit any sides that have been sliced to 0px.
			w += applyDimensions(slice.left != '0' && parseFloat(borderWidth.left) || 0, outset.left || 0, true);
			w += applyDimensions(slice.right != '0' && parseFloat(borderWidth.right) || 0, outset.right || 0, true);
			h += applyDimensions(slice.top != '0' && parseFloat(borderWidth.top) || 0, outset.top || 0, true);
			h += applyDimensions(slice.bottom != '0' && parseFloat(borderWidth.bottom) || 0, outset.bottom || 0, true);

			disableScaling = true;

			geom = { width: w, height: h };
		}

		while ((token = reg.exec(value))) {
			if (hasPaints === false) {
				paintId = ensurePaintId(element);
			}

			hasPaints = true;
			newValue += value.substring(0, token.index);
			let painterName = token[4] || token[5];
			let currentUri = token[3];
			let painter = getPainter(painterName);
			let contextOptions = painter && painter.Painter.contextOptions || {};
			let equivalentDpr = disableScaling || contextOptions.scaling === false ? 1 : dpr;

			let inst;
			if (painter) {
				if (painter.Painter.inputProperties) {
					observedProperties.push.apply(observedProperties, painter.Painter.inputProperties);
				}
				inst = getPainterInstance(painter);
			}

			if (contextOptions.nativePixels===true) {
				geom.width *= dpr;
				geom.height *= dpr;
				equivalentDpr = 1;
			}

			let actualWidth = equivalentDpr * geom.width,
				actualHeight = equivalentDpr * geom.height;

			let ctx = element.$$paintContext;
			let cssContextId = `paint-${paintId}-${painterName}`;
			let canvas = ctx && ctx.canvas;

			// Changing the -webkit-canvas() id requires getting a new context.
			const requiresNewBackingContext = USE_CSS_CANVAS_CONTEXT===true && ctx && cssContextId !== ctx.id;

			if (!canvas || canvas.width!=actualWidth || canvas.height!=actualHeight || requiresNewBackingContext) {
				if (USE_CSS_CANVAS_CONTEXT===true) {
					ctx = document.getCSSCanvasContext('2d', cssContextId, actualWidth, actualHeight);
					ctx.id = cssContextId;
					// Note: even when we replace ctx here, we don't update `canvas`.
					// This is to enable the id !== check that sets hasChanged=true later.
					if (element.$$paintContext) {
						// clear any re-used context
						ctx.clearRect(0, 0, actualWidth, actualHeight);
					}
				}
				else {
					let shouldAppend = false;
					if (!canvas) {
						canvas = document.createElement('canvas');
						canvas.id = cssContextId;
						shouldAppend = USE_CSS_ELEMENT;
					}
					canvas.width = actualWidth;
					canvas.height = actualHeight;
					if (shouldAppend) {
						canvas.style.display = 'none';
						root.appendChild(canvas);
					}
					ctx = canvas.getContext('2d');
				}
				element.$$paintContext = ctx;
				ctx.imageSmoothingEnabled = false;
				if (equivalentDpr!==1) ctx.scale(equivalentDpr, equivalentDpr);
			}
			else {
				ctx.clearRect(0, 0, actualWidth, actualHeight);

				// This hack is no longer needed thanks to the closePath() fix
				// if (USE_CSS_CANVAS_CONTEXT===false) {
				// 	ctx = ctx.canvas.getContext('2d');
				// }
			}

			if (inst) {
				ctx.save();
				ctx.beginPath();
				inst.paint(ctx, geom, propertiesContainer);
				// Close any open path so clearRect() can dump everything
				ctx.closePath();
				// ctx.stroke();  // useful to verify that the polyfill painted rather than native paint().
				ctx.restore();
				// -webkit-canvas() is scaled based on DPI by default, we don't want to reset that.
				if (USE_CSS_CANVAS_CONTEXT===false && !USE_CSS_ELEMENT && 'resetTransform' in ctx) {
					ctx.resetTransform();
				}
			}

			newValue += token[1];

			if (USE_CSS_CANVAS_CONTEXT===true) {
				newValue += `-webkit-canvas(${cssContextId})`;
				// new or replaced context (note: `canvas` is any PRIOR canvas)
				if (token[4] == null || canvas && canvas.id !== cssContextId) {
					hasChanged = true;
				}
			}
			else if (USE_CSS_ELEMENT===true) {
				newValue += `-moz-element(#${cssContextId})`;
				if (token[4] == null) hasChanged = true;
				// `canvas` here is the current canvas.
				if (canvas && canvas.id !== cssContextId) {
					canvas.id = cssContextId;
					hasChanged = true;
				}
			}
			else {
				let uri = canvas.toDataURL('image/png').replace('/png', '/paint-' + painterName);
				if (typeof MSBlobBuilder==='function') {
					uri = dataUrlToBlob(uri, painterName);
				}
				// let uri = ctx.canvas.toDataURL('image/bmp', 1).replace('/bmp', '/paint-' + painterName);
				urls.push(uri);
				newValue += 'url("' + uri + '")';
				if (uri!==currentUri || !paintRule) {
					let j = currentUri ? currentUri.indexOf('#') : -1;
					if (~j) URL.revokeObjectURL(currentUri.substring(0, j));
					hasChanged = true;
				}
				currentUri = uri;
			}

			newValue += token[6];
			index = token.index + token[0].length;
		}

		if (hasPaints===false && paintedProperties!=null && paintedProperties[property]!=null) {
			if (!paintRule) paintRule = getPaintRuleForElement(element);
			paintRule.style.removeProperty(property);
			if (resizeObserver) resizeObserver.unobserve(element);
			if (element.$$paintGeometry) element.$$paintGeometry.live = false;
			continue;
		}

		newValue += value.substring(index);
		if (hasChanged) {
			if (!paintRule) paintRule = getPaintRuleForElement(element);

			if (paintedProperties==null) {
				paintedProperties = element.$$paintedProperties = {};
			}
			paintedProperties[property] = true;

			if (property.substring(0, 10) === 'background' && dpr !== 1) {
				// `${geom.width}px ${geom.height}px` `contain`
				applyStyleRule(paintRule.style, 'background-size', `100% 100%`);
			}

			if (/mask/.test(property) && dpr !== 1) {
				applyStyleRule(paintRule.style, 'mask-size', 'contain');
				// cheat: "if this is Safari"
				if (USE_CSS_CANVAS_CONTEXT) {
					applyStyleRule(paintRule.style, '-webkit-mask-size', 'contain');
				}
			}

			// `border-color:transparent` in Safari overrides border-image
			if (/border-image/.test(property) && USE_CSS_CANVAS_CONTEXT) {
				applyStyleRule(paintRule.style, 'border-color', 'initial');
				applyStyleRule(paintRule.style, 'image-rendering', 'optimizeSpeed'); // -webkit-crisp-edges
			}

			if (urls.length===0) {
				applyStyleRule(paintRule.style, property, newValue);
			}
			else {
				loadImages(urls, applyStyleRule, [paintRule.style, property, newValue]);
			}
		}
	}

	element.$$paintObservedProperties = observedProperties.length===0 ? null : observedProperties;
	let propertyValues = element.$$paintedPropertyValues = {};
	for (let i=0; i<observedProperties.length; i++) {
		let prop = observedProperties[i];
		// use propertyContainer here to select cached values
		propertyValues[prop] = propertiesContainer.getRaw(prop);
	}

	if (element.$$needsOverrides === true) enableOverrides();
	element.$$needsOverrides = null;
}

let overrideLocks = 0;
function disableOverrides() {
	if (!overrideLocks++) overridesStylesheet.disabled = true;
}
function enableOverrides() {
	if (!--overrideLocks) overridesStylesheet.disabled = false;
}

function dataUrlToBlob(dataUrl, name) {
	let bin = atob(dataUrl.split(',')[1]),
		arr = new Uint8Array(bin.length);
	for (let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
	return URL.createObjectURL(new Blob([arr])) + '#paint=' + name;
}

function applyStyleRule(style, property, value) {
	let o = bypassStyleHooks;
	bypassStyleHooks = true;
	style.setProperty(property, value, 'important');
	bypassStyleHooks = o;
}

// apply a dimension offset to a base unit value (used for computing border-image sizes)
function applyDimensions(base, dim, omitBase) {
	const r = omitBase ? 0 : base;
	let v = parseFloat(dim);
	if (!dim) return r;
	if (dim.match('px')) return r + v;
	if (dim.match('%')) v /= 100;
	return base * v;
}

// Compute dimensions from a CSS unit group
function parseCssDimensions(arr) {
	return {
		top: arr[0],
		bottom: arr[2] || arr[0],
		left: arr[3] || arr[1] || arr[0],
		right: arr[1] || arr[0]
	};
}

function PaintWorklet() {}
PaintWorklet.prototype.addModule = function(url) {
	let p, resolve;
	if (HAS_PROMISE) {
		p = new Promise((r) => resolve = r);
	}

	fetchText(url, code => {
		let context = {
			registerPaint(name, Painter) {
				registerPaint(name, Painter, {
					context,
					realm
				});
			}
		};
		defineProperty(context, 'devicePixelRatio', {
			get: getDevicePixelRatio
		});
		context.self = context;
		let parent = styleIsolationFrame.contentDocument && styleIsolationFrame.contentDocument.body || root;
		let realm = new Realm(context, parent);

		code = (this.transpile || String)(code);

		realm.exec(code);
		if (resolve) resolve();
	});

	return p;
};

function init() {
	let lock = false;
	new MutationObserver(records => {
		if (lock===true || overrideLocks) return;
		lock = true;
		for (let i = 0; i < records.length; i++) {
			let record = records[i], target = record.target, added, removed;
			// Ignore all inline SVG mutations:
			if (target && 'ownerSVGElement' in target) {
				continue;
			}
			if (record.type === 'childList') {
				if ((added = record.addedNodes)) {
					for (let j = 0; j < added.length; j++) {
						if (added[j].nodeType === 1) {
							// Newly inserted elements can contain entire subtrees
							// if constructed before the root is attached. Only the root
							// emits a mutation, so we have to visit all children:
							walk(added[j], queueUpdate);
						}
					}
				}
				if ((removed = record.removedNodes)) {
					for (let j = 0; j < removed.length; j++) {
						if (resizeObserver && removed[j].$$paintGeometry) {
							removed[j].$$paintGeometry.live = false;
							if (resizeObserver) resizeObserver.unobserve(removed[j]);
						}
					}
				}
			}
			else if (record.type==='attributes' && target.nodeType === 1) {
				// prevent removal of data-css-paint attribute
				if (record.attributeName === 'data-css-paint' && record.oldValue && target.$$paintId != null && !target.getAttribute('data-css-paint')) {
					ensurePaintId(target);
					continue;
				}
				walk(target, invalidateElementGeometry);
			}
		}
		lock = false;
	}).observe(document.body, {
		childList: true,
		attributes: true,
		attributeOldValue: true,
		subtree: true
	});

	const setAttributeDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
	const oldSetAttribute = setAttributeDesc.value;
	setAttributeDesc.value = function(name, value) {
		if (name === 'style' && HAS_PAINT.test(value)) {
			value = escapePaintRules(value);
			ensurePaintId(this);
			this.$$needsOverrides = true;
			invalidateElementGeometry(this);
		}
		return oldSetAttribute.call(this, name, value);
	};
	defineProperty(Element.prototype, 'setAttribute', setAttributeDesc);

	// avoid frameworks removing the data-css-paint attribute:
	const removeAttributeDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'removeAttribute');
	const oldRemoveAttribute = removeAttributeDesc.value;
	removeAttributeDesc.value = function(name) {
		if (name === 'data-css-paint') return;
		return oldRemoveAttribute.call(this, name);
	};
	defineProperty(Element.prototype, 'removeAttribute', removeAttributeDesc);

	let styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
	const oldStyleGetter = styleDesc.get;
	styleDesc.set = function(value) {
		const style = styleDesc.get.call(this);
		return style.cssText = value;
	};
	styleDesc.get = function() {
		const style = oldStyleGetter.call(this);
		if (style.ownerElement !== this) {
			defineProperty(style, 'ownerElement', { value: this });
		}
		return style;
	};
	defineProperty(HTMLElement.prototype, 'style', styleDesc);

	/** @type {PropertyDescriptorMap} */
	const propDescs = {};

	let cssTextDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
	let oldSet = cssTextDesc.set;
	cssTextDesc.set = function (value) {
		if (!overrideLocks && HAS_PAINT.test(value)) {
			value = value && escapePaintRules(value);
			const owner = this.ownerElement;
			if (owner) {
				ensurePaintId(owner);
				owner.$$needsOverrides = true;
				invalidateElementGeometry(owner);
			}
		}
		return oldSet.call(this, value);
	};
	propDescs.cssText = cssTextDesc;

	const properties = Object.keys((window.CSS2Properties || CSSStyleDeclaration).prototype).filter(m => IMAGE_CSS_PROPERTIES.test(m));
	properties.forEach((prop) => {
		const n = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
		propDescs[prop] = {
			configurable: true,
			enumerable: true,
			get() {
				let pri = this.getPropertyPriority(n);
				return this.getPropertyValue(n) + (pri ? ' !'+pri : '');
			},
			set(value) {
				const v = String(value).match(/^(.*?)\s*(?:!\s*(important)\s*)?$/);
				this.setProperty(n, v[1], v[2]);
				return this[prop];
			}
		};
	});

	let setPropertyDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'setProperty');
	let oldSetProperty = setPropertyDesc.value;
	setPropertyDesc.value = function (name, value, priority) {
		if (!bypassStyleHooks && !overrideLocks && HAS_PAINT.test(value)) {
			value = value && escapePaintRules(value);
			const owner = this.ownerElement;
			if (owner) {
				ensurePaintId(owner);
				owner.$$needsOverrides = true;
				invalidateElementGeometry(owner);
			}
		}
		oldSetProperty.call(this, name, value, priority);
	};
	propDescs.setProperty = setPropertyDesc;

	Object.defineProperties(CSSStyleDeclaration.prototype, propDescs);
	if (window.CSS2Properties) {
		Object.defineProperties(window.CSS2Properties.prototype, propDescs);
	}

	addEventListener('resize', () => {
		processItem('[data-css-paint]');
	});

	const OPTS = { passive: true };

	[
		'animationiteration',
		'animationend',
		'animationstart',
		'transitionstart',
		'transitionend',
		'transitionrun',
		'transitioncancel',
		'mouseover',
		'mouseout',
		'mousedown',
		'mouseup',
		'focus',
		'blur'
	].forEach(event => {
		addEventListener(event, updateFromEvent, OPTS);
	});

	function updateFromEvent(e) {
		let t = e.target;
		while (t) {
			if (t.nodeType === 1) queueUpdate(t);
			t = t.parentNode;
		}
	}

	update();
	processItem('[style*="paint"]');
}

if (!supportsPaintWorklet) {
	try {
		init();
	}
	catch (e) {
	}
}
