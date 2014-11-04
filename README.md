# DOM Profiler FirefoxDevTools add-on

This is a Firefox DevTools add-on that records changes on the current page.

Once started, it records DOM mutations and DOM events, and list them live as you interact with the page.

Mutations and event target elements are recorded too and can be highlighted and selected in the inspector.

## How to install

The addon isn't on http://addons.mozilla.org/ yet, but there's an `xpi` file you can drag/drop in Firefox.
It was developed with Firefox 35, but may work with earlier versions, although this is untested.

Note that this addon will only work when using the devtools in a local browser tab, not when debugging a remote device (via the WebIDE).

## How to build and run

* [install JPM](https://www.npmjs.org/package/jpm)
* `git clone https://github.com/captainbrosset/pagerecorder`
* `cd pagerecorder`
* `jpm run -b /path/to/firefox/nightly/bin`
