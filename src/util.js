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

/** Canvas#toBlob() ponyfill */
export function canvasToBlob(canvas, callback, type, quality) {
	if (canvas.toBlob) return canvas.toBlob(callback, type, quality);

	let bin = atob(canvas.toDataURL(type, quality).split(',')[1]),
		arr = new Uint8Array(bin.length);
	for (let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
	callback(new Blob([arr], { type }));
}

/** Basically fetch(u).then( r => r.text() ) */
export function fetchText(url, callback) {
	let xhr = new XMLHttpRequest();
	xhr.onreadystatechange = () => {
		if (xhr.readyState===4) {
			callback(xhr.responseText);
		}
	};
	xhr.open('GET', url, true);
	xhr.send();
}

/** Object.defineProperty() ponyfill */
export function defineProperty(obj, name, def) {
	if (Object.defineProperty) {
		Object.defineProperty(obj, name, def);
	}
	else {
		obj[name] = def.get();
	}
}
