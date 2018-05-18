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

/* eslint-disable */

// Copied verbatim from houdini-samples:
// https://github.com/GoogleChromeLabs/houdini-samples/blob/master/paint-worklet/ripple

// Inject a tiny tranpiler to make IE11+ behave nicely:
try {
	eval('class F {}');
}
catch(e) {
	CSS.paintWorklet.transpile = window.transpilerLite;
}

CSS.paintWorklet.addModule('./ripple-worklet.js');

if (!window.performance) window.performance = { now: Date.now.bind(Date) };

if (!window.requestAnimationFrame) window.requestAnimationFrame = function(cb) { return setTimeout(doAnim, cb); };
function doAnim(cb) { cb(performance.now()); }

function ripple(evt) {
	var button = this,
		rect = button.getBoundingClientRect(),
		x = evt.clientX - rect.left,
		y = evt.clientY - rect.top,
		start = performance.now();
	button.classList.add('animating');
	requestAnimationFrame(function raf(now) {
		var count = Math.floor(now - start);
		button.style.cssText = '--ripple-x: ' + x + '; --ripple-y: ' + y + '; --animation-tick: ' + count + ';';
		if (count > 1000) {
			button.classList.remove('animating');
			button.style.cssText = '--animation-tick: 0;';
			return;
		}
		requestAnimationFrame(raf);
	})
}
[].forEach.call(document.querySelectorAll('.ripple'), function (el) {
	el.addEventListener('click', ripple);
});