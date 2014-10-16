# Page Recorder FirefoxDevTools add-on

pagerecorder is a really bad name but naming things is hard.

This is a Firefox DevTools add-on that records changes on the current page.

Start it and it will record DOM mutations and events, plus it will remember the state of the page and the target node for each change.

Stop it and it will list those changes in the toolbox so that you can mouseover them and see what happened in the page while it was being recorded.

Here's a short demo video: https://www.youtube.com/watch?v=y6JSoddYQKg&feature=youtu.be

## How to install

The addon isn't on http://addons.mozilla.org/ yet, but there's an `xpi` file you can drag/drop in Firefox.
It was developed with Firefox 35, but may work with earlier versions, although this is untested.

Note that this addon will only work when using the devtools in a local browser tab, not when debugging a remote device (via the WebIDE).

## How to build and run

* [install JPM](https://www.npmjs.org/package/jpm)
* `git clone https://github.com/captainbrosset/pagerecorder`
* `cd pagerecorder`
* `jpm run -b /path/to/firefox/nightly/bin`
