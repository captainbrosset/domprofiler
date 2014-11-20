# DOM Profiler FirefoxDevTools add-on

This is a Firefox DevTools add-on that records changes on the current page.

Once started, it records DOM mutations and DOM events, and list them live as you interact with the page.

Mutations and event target elements are recorded too and can be highlighted and selected in the inspector.

## How to install

The addon isn't yet on addons.mozilla.org so you'll need to insall it by drag'n'dropping the XPI in this repository to your browser.

Note that this addon will only work when using the devtools in a local browser tab, not when debugging a remote device (via the WebIDE). At least until issue #10 is fixed.

## How to build and run

* [install JPM](https://www.npmjs.org/package/jpm)
* `git clone https://github.com/captainbrosset/domprofiler`
* `cd domprofiler`
* `jpm run -b /path/to/firefox/nightly/bin`
