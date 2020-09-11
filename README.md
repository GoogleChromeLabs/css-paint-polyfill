<p align="center">
  <a href="https://googlechromelabs.github.io/css-paint-polyfill/"><img src="https://i.imgur.com/xqSHmd2.gif" width="400" alt="CSS Paint Polyfill demo"></a>

  <h1 align="center">
    CSS Custom Paint / Paint Worklets polyfill
    <a href="https://www.npmjs.org/package/css-paint-polyfill"><img src="https://img.shields.io/npm/v/css-paint-polyfill.svg?style=flat" alt="npm"></a>
  </h1>
</p>

A polyfill that brings Houdini's [CSS Custom Paint API] and Paint Worklets to all modern browsers (Edge, Firefox, Safari and Chrome).

Performance is particularly good in Firefox and Safari, where this polyfill leverages `-webkit-canvas()` and `-moz-element()` for optimized rendering. For other browsers, framerate is governed by Canvas `toDataURL()` / `toBlob()` speed.

As of version 3, this polyfill also includes basic implementations of `CSS.supports()`, `CSS.registerProperty()` and CSS unit functions (`CSS.px()` etc), which are injected in browsers without native support.

## What are Paint Worklets?

Paint Worklets are JavaScript modules in which you can program custom graphics code. Once registered, they can be applied to elements using CSS:

<table><tbody><tr valign="top"><td>

An example `box.js` worklet:

```js
registerPaint('box', class {
  paint(ctx, geom, properties) {
    ctx.fillRect(0, 0, geom.width, geom.height)
  }
})
```

</td><td>

... registered and applied on a page:

```js
CSS.paintWorklet.addModule('./box.js')

var el = document.querySelector('h1')
el.style.background = 'paint(box)'
```

</td></tr></tbody></table>

For a more complete example, see the [demo](https://github.com/GoogleChromeLabs/css-paint-polyfill/tree/master/demo).

---

## Installation & Usage

```html
<script src="css-paint-polyfill.js"></script>
<!-- or: -->
<script src="https://unpkg.com/css-paint-polyfill"></script>
```

Or with a bundler:

```js
import 'css-paint-polyfill';
```

... or with ES Modules on the web:

```js
import 'https://unpkg.com/css-paint-polyfill';
```

---

## Contributing

See [CONTRIBUTING.md](https://github.com/GoogleChromeLabs/css-paint-polyfill/blob/master/CONTRIBUTING.md).

To hack on the polyfill locally:

```sh
git clone git@github.com:GoogleChromeLabs/css-paint-polyfill.git
cd css-paint-polyfill
npm i
npm start
# open http://localhost:5000
```

---

<p align="center">
  <img src="https://i.imgur.com/Nat1PNX.png" width="300" height="300" alt="css-paint-polyfill">
</p>

[CSS Custom Paint API]: https://developers.google.com/web/updates/2018/01/paintapi
