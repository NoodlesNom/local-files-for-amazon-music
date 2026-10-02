# Amazon Music Local Files

A free Microsoft Edge extension that plays audio files from this computer as a Local Files playlist inside Amazon Music. Version 1.0.0.

It anchors to an Amazon playlist titled exactly `LOCAL PLACEHOLDER` and shows that playlist as **Local Files**. Add songs on that page. Playback uses the files on this computer. Audio bytes are not uploaded to the developer and are not written into extension storage.

It sits with [History Playlist for Amazon Music](https://noodlesnom.github.io/history-playlist-for-amazon-music/) and [Find in Playlist for Amazon Music](https://noodlesnom.github.io/find-in-playlist-for-amazon-music/). Find in Playlist hides its search button while the Local Files playlist is open.

Not affiliated with Amazon.

## Install (load unpacked)

1. Download the latest release ZIP and unzip it (or clone this repository).
2. Open `edge://extensions` (in Chrome: `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Open Amazon Music and the Local Files playlist. Use **Add songs**, or drag audio files onto the page.

English Amazon Music sites only: music.amazon.com, .ca, .co.uk, .com.au, .in, and .ae.

## What it does

- Shows the placeholder playlist as **Local Files**.
- Adds songs from a file picker or a drag-and-drop onto the Amazon Music page. Accepted types include mp3, m4a, mp4, flac, wav, ogg, aac, opus, and webm.
- Reads title, artist, and cover art from the file in the browser. A filename such as `Artist - Title` is used when the file has no tags.
- Plays the file locally: play and pause, seek, next and previous, shuffle, repeat, a queue, and volume.
- Sorts the list by title (A to Z or Z to A) or by added order, and can search the local song names.
- Remembers file handles in IndexedDB so a pick can be opened again after a reload. Audio bytes are not stored. Names and artists are kept in extension storage.
- The toolbar popup lists those names and can create the empty `LOCAL PLACEHOLDER` playlist if it is missing. That playlist is public on Amazon Music and starts with no catalog tracks. The extension does not upload your audio to Amazon.

## Privacy

The developer collects nothing. Audio stays on this computer. Looking up or creating the anchor playlist uses the Amazon Music page you already have open. See [the site](https://noodlesnom.github.io/local-files-for-amazon-music/).

## License

MIT. Copyright (c) 2026 NoodlesNom.
