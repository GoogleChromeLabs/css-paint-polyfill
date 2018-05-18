# CSS Paint Polyfill

This is a polyfill for the [CSS Paint API].

Performance is quite good in Firefox and Safari courtesy of `-webkit-canvas()` and `-moz-element()`. For the remaining browsers, framerate is govered by Canvas `toDataURL()` / `toBlob()` speed.

# Usage

```html
<script src="css-paint-polyfill.js"></script>
<!-- or: -->
<script src="//unpkg.com/css-paint-polyfill/dist/css-paint-polyfill.js"></script>
```

Or with a bundler:

```js
import 'css-paint-polyfill';
```

... or with ES Modules on the web:

```js
import('//unpkg.com/css-paint-polyfill/dist/css-paint-polyfill.js');
```

# To-Do

- [ ] Add second `options` argument to `addModule()` ([spec](https://drafts.css-houdini.org/worklets/#dictdef-workletoptions))
- [ ] Extract `addModule()` into its own repo ([spec](https://drafts.css-houdini.org/worklets/#dom-worklet-addmodule))

[CSS Paint API]: https://developers.google.com/web/updates/2018/01/paintapi
