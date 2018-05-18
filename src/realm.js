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

export function Realm(scope, parentElement) {
	let frame = document.createElement('iframe');
	frame.style.cssText = 'position:absolute; left:0; top:-999px; width:1px; height:1px;';
	parentElement.appendChild(frame);
	let win = frame.contentWindow,
		doc = win.document,
		vars = 'var window,$hook';
	for (let i in win) {
		if (!(i in scope) && i!=='eval') {
			vars += ',';
			vars += i;
		}
	}
	for (let i in scope) {
		vars += ',';
		vars += i;
		vars += '=self.';
		vars += i;
	}
	let script = doc.createElement('script');
	script.appendChild(doc.createTextNode(
		`function $hook(self,console) {"use strict";
		${vars};return function() {return eval(arguments[0])}}`
	));
	doc.body.appendChild(script);
	this.exec = win.$hook(scope, console);
	// this.destroy = () => { parentElement.removeChild(frame); };
}
