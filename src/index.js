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

// Use a getter here (if available) to avoid installing
// our MutationObserver if the API is never used.
if (!window.CSS) window.CSS = {};

if (!('paintWorklet' in window.CSS)) {
	defineProperty(window.CSS, 'paintWorklet', {
		get: () => (paintWorklet || (paintWorklet = new PaintWorklet()))
	});
}

const GLOBAL_ID = 'css-paint-polyfill';

let root = document.createElement(GLOBAL_ID);
root.style.cssText = 'display: none;';
document.documentElement.appendChild(root);

let styleIsolationFrame = document.createElement('iframe');
styleIsolationFrame.style.cssText = 'position:absolute; left:0; top:-999px; width:1px; height:1px;';
root.appendChild(styleIsolationFrame);

let overridesStylesheet = document.createElement('style');
overridesStylesheet.id = GLOBAL_ID;
overridesStylesheet.$$isPaint = true;
root.appendChild(overridesStylesheet);
let overrideStyles = overridesStylesheet.sheet;
let testStyles = root.style;

const EMPTY_ARRAY = [];
const HAS_PAINT = /(paint\(|-moz-element\(#paint-|-webkit-canvas\(paint-|[('"]blob:[^'"#]+#paint=|[('"]data:image\/paint-)/;
const USE_CSS_CANVAS_CONTEXT = 'getCSSCanvasContext' in document;
const USE_CSS_ELEMENT = (testStyles.backgroundImage = `-moz-element(#${GLOBAL_ID})`) === testStyles.backgroundImage;
const HAS_PROMISE = (typeof Promise === 'function');
testStyles.cssText = '';

let supportsStyleMutations = true;
let raf = window.requestAnimationFrame || setTimeout;
let defer = HAS_PROMISE ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout;
let getDevicePixelRatio = () => window.devicePixelRatio || 1;

let painters = {};
let trackedRules = {};
let styleSheetCounter = 0;

addEventListener('resize', () => {
	processItem('[data-css-paint]', true);
});

function registerPaint(name, Painter, worklet) {
	// if (painters[name]!=null) throw Error(`registerPaint(${name}): name already registered`);
	painters[name] = {
		worklet,
		Painter,
		properties: Painter.inputProperties ? [].slice.call(Painter.inputProperties) : [],
		bit: 0,
		instances: []
	};
	update();
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

	if (context.isNew === true && HAS_PAINT.test(css)) {
		if (css !== (css = escapePaintRules(css))) {
			rule = replaceRule(rule, css);
		}
	}

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
			sheetId: null
		};

	for (let i=0; i<sheets.length; i++) {
		let node = sheets[i].ownerNode;
		if (node.$$isPaint) continue;

		// Check that we can access the sheet.
		// The rules binding is required in order to prevent Terser from removing the block.
		// eslint-disable-next-line no-unused-vars
		let rules;
		try { rules = node.sheet.cssRules; }
		catch (e) { continue; }

		context.sheetId = node.$$paintid;
		context.isNew = context.sheetId == null;
		if (context.isNew) {
			context.sheetId = node.$$paintid = ++styleSheetCounter;
			// allow processing to defer parse
			if (processNewSheet(node)===false) {
				continue;
			}
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
	const parent = styleIsolationFrame.contentWindow.document.body;

	let style = document.createElement('style');
	style.setAttribute('disabled', 'disabled');
	style.media = 'worklet';
	style.$$paintid = ++styleSheetCounter;
	style.appendChild(document.createTextNode(escapePaintRules(css)));
	parent.appendChild(style);

	let newSheet = '';
	walkStyles(style.sheet, (rule) => {
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

	parent.removeChild(style);

	if (newSheet) {
		const pageStyles = document.createElement('style');
		pageStyles.$$paintid = styleSheetCounter;
		pageStyles.appendChild(document.createTextNode(newSheet));
		root.appendChild(pageStyles);
	}

	update();
}

function escapePaintRules(css) {
	return css.replace(/(;|,|\b)paint\s*\(\s*(['"]?)(.+?)\2\s*\)(;|,|!|\b)/g, '$1url(data:image/paint-$3,=)$4');
}

let updateQueue = [];
function queueUpdate(element, forceInvalidate) {
	if (forceInvalidate) {
		element.$$paintObservedProperties = null;
	}
	if (element.$$paintPending===true) return;
	element.$$paintPending = true;
	if (updateQueue.indexOf(element) === -1 && updateQueue.push(element) === 1) {
		defer(processUpdateQueue);
	}
}
function processUpdateQueue() {
	let el;
	while ((el = updateQueue.pop())) {
		maybeUpdateElement(el);
	}
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
		patchCssText(element);
	}
	return paintId;
}

function getPaintRuleForElement(element) {
	let paintRule = element.$$paintRule,
		paintId = ensurePaintId(element);
	if (paintRule==null) {
		if (!element.hasAttribute('data-css-paint')) {
			element.setAttribute('data-css-paint', paintId);
		}
		let index = overrideStyles.insertRule(`[data-css-paint="${idCounter}"] {}`, overrideStyles.cssRules.length);
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
	if (element.$$paintObservedProperties) {
		for (let i=0; i<element.$$paintObservedProperties.length; i++) {
			let prop = element.$$paintObservedProperties[i];
			if (computed.getPropertyValue(prop).trim() !== element.$$paintedPropertyValues[prop].trim()) {
				updateElement(element, computed);
				break;
			}
		}
	}
	else if (element.$$paintId || HAS_PAINT.test(getCssText(computed))) {
		updateElement(element, computed);
		return;
	}

	element.$$paintPending = false;
}

let currentProperties, propertyContainerCache;
const propertiesContainer = {
	get(name) {
		if (name in propertyContainerCache) return propertyContainerCache[name];
		return propertyContainerCache[name] = currentProperties.getPropertyValue(name);
	}
};

let idCounter = 0;
function updateElement(element, computedStyle) {
	overridesStylesheet.disabled = true;
	let style = currentProperties = computedStyle==null ? getComputedStyle(element) : computedStyle;
	// element.$$paintGeom = style;
	propertyContainerCache = {};
	let paintRule;
	let observedProperties = [];

	element.$$paintPending = false;

	// @TODO get computed styles and precompute geometry in a rAF after first paint, then re-use w/ invalidation
	let elementGeometry = {
		width: element.clientWidth,
		height: element.clientHeight
	};

	let dpr = getDevicePixelRatio();

	let paintedProperties = element.$$paintedProperties;

	for (let i=0; i<style.length; i++) {
		let property = style[i],
			value = propertiesContainer.get(property),
			reg = /(,|\b|^)url\((['"]?)((?:-moz-element\(#|-webkit-canvas\()paint-\d+-([^;,]+)\)|(?:data:image\/paint-|blob:[^'"#]+#paint=)([^"';, ]+)(?:[;,].*?)?)\2\)(;|,|\s|\b|$)/g,
			newValue = '',
			index = 0,
			urls = [],
			hasChanged = false,
			hasPaints = false,
			paintId,
			token,
			geom = elementGeometry;
		
		// Support CSS Border Images
		if (/border-image/.test(property)) {
			let w = geom.width;
			let h = geom.height;

			const slice = parseCssDimensions(
				propertiesContainer
					.get('border-image-slice')
					.replace(/\sfill/, '')
					.split(' ')
			);
			w -= applyDimensions(w, slice.left) + applyDimensions(w, slice.right);
			h -= applyDimensions(h, slice.top) + applyDimensions(h, slice.bottom);

			const outset = parseCssDimensions(propertiesContainer.get('border-image-outset').split(' '));
			w = applyDimensions(applyDimensions(w, outset.left), outset.right);
			h = applyDimensions(applyDimensions(h, outset.top), outset.bottom);

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
			let equivalentDpr = contextOptions.scaling === false ? 1 : dpr;

			let inst;
			if (painter) {
				// if (!painter) {
				// 	element.$$paintPending = true;
				// 	overridesStylesheet.disabled = false;
				// 	// setTimeout(maybeUpdateElement, 10, element);
				// 	return;
				// }
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
			
			let ctx = element.$$paintContext,
				cssContextId = `paint-${paintId}-${painterName}`;
			if (!ctx || !ctx.canvas || ctx.canvas.width!=actualWidth || ctx.canvas.height!=actualHeight) {
				if (USE_CSS_CANVAS_CONTEXT===true) {
					ctx = document.getCSSCanvasContext('2d', cssContextId, actualWidth, actualHeight);
				}
				else {
					let canvas = document.createElement('canvas');
					canvas.id = cssContextId;
					canvas.width = actualWidth;
					canvas.height = actualHeight;
					if (USE_CSS_ELEMENT===true) {
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
				if (USE_CSS_CANVAS_CONTEXT===false && 'resetTransform' in ctx) {
					ctx.resetTransform();
				}
			}

			newValue += token[1];

			if (USE_CSS_CANVAS_CONTEXT===true) {
				newValue += `-webkit-canvas(${cssContextId})`;
				hasChanged = token[4]==null;
			}
			else if (USE_CSS_ELEMENT===true) {
				newValue += `-moz-element(#${cssContextId})`;
				hasChanged = token[4] == null;
			}
			else {
				let uri = ctx.canvas.toDataURL('image/png').replace('/png', '/paint-' + painterName);
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
				applyStyleRule(paintRule.style, 'background-size', `${geom.width}px ${geom.height}px`);
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
		propertyValues[prop] = propertiesContainer.get(prop);
	}

	overridesStylesheet.disabled = false;
}

function dataUrlToBlob(dataUrl, name) {
	let bin = atob(dataUrl.split(',')[1]),
		arr = new Uint8Array(bin.length);
	for (let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
	return URL.createObjectURL(new Blob([arr])) + '#paint=' + name;
}

function applyStyleRule(style, property, value) {
	style.setProperty(property, value, 'important');
}

function patchCssText(element) {
	if (supportsStyleMutations===true) return;
	if (element.style.ownerElement===element) return;
	defineProperty(element.style, 'ownerElement', { value: element });
}

// apply a dimension offset to a base unit value (used for computing border-image sizes)
function applyDimensions(base, dim) {
	let v = parseFloat(dim);
	if (!dim) return base;
	if (dim.match('px')) return base + v;
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

class PaintWorklet {
	constructor() {
		raf(update);

		let a = document.createElement('x-a');
		document.body.appendChild(a);

		let supportsStyleMutations = false;

		let lock = false;
		new MutationObserver(records => {
			if (lock===true) return;
			lock = true;
			for (let i = 0; i < records.length; i++) {
				let record = records[i], added;
				// Ignore all inline SVG mutations:
				if (record.target && 'ownerSVGElement' in record.target) {
					continue;
				}
				if (record.type === 'childList' && (added = record.addedNodes)) {
					for (let j = 0; j < added.length; j++) {
						if (added[j].nodeType === 1) {
							queueUpdate(added[j]);
						}
					}
				}
				else if (record.type==='attributes' && record.target.nodeType === 1) {
					if (record.target === a) {
						supportsStyleMutations = true;
					}
					else {
						walk(record.target, queueUpdate);
					}
				}
			}
			lock = false;
		}).observe(document.body, {
			childList: true,
			attributes: true,
			subtree: true
		});

		a.style.cssText = 'color: red;';
		setTimeout( () => {
			document.body.removeChild(a);
			if (!supportsStyleMutations) {
				let styleDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style');
				const oldStyleGetter = styleDesc.get;
				styleDesc.get = function() {
					const style = oldStyleGetter.call(this);
					style.ownerElement = this;
					return style;
				};
				defineProperty(HTMLElement.prototype, 'style', styleDesc);

				let cssTextDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
				let oldSet = cssTextDesc.set;
				cssTextDesc.set = function (value) {
					if (this.ownerElement) queueUpdate(this.ownerElement);
					return oldSet.call(this, value);
				};
				defineProperty(CSSStyleDeclaration.prototype, 'cssText', cssTextDesc);

				let setPropertyDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'setProperty');
				let oldSetProperty = setPropertyDesc.value;
				setPropertyDesc.value = function (name, value, priority) {
					if (this.ownerElement) queueUpdate(this.ownerElement);
					oldSetProperty.call(this, name, value, priority);
				};
				defineProperty(CSSStyleDeclaration.prototype, 'setProperty', setPropertyDesc);
			}
		});
	}

	addModule(url) {
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
			let realm = new Realm(context, root);

			code = (this.transpile || String)(code);

			realm.exec(code);
			if (resolve) resolve();
		});

		return p;
	}
}
