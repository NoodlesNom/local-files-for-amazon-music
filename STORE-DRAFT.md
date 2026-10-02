# Edge Add-ons store draft

Do not submit this. The listing has not been submitted. Paste it into Partner Center only when you choose to save a draft, and do not click Submit, Publish, or Send for review.

The short description is not a separate store field you can type. Microsoft Edge Add-ons uses the `description` string in `manifest.json`. That string is already set to the short description below. The extension name in the manifest is already the name below. Version in the package is 1.0.0. This draft was not submitted.

## Name

Amazon Music Local Files

## Short description

Play audio files from this computer as a Local Files playlist anchored to an Amazon playlist named LOCAL PLACEHOLDER.

(117 characters. Chromium shows the manifest description in the browser UI with a 132-character limit. The manifest string is left unchanged.)

## Long description

Amazon Music Local Files plays audio files from this computer inside the Amazon Music website.

It anchors to an Amazon playlist titled exactly LOCAL PLACEHOLDER and shows that playlist as Local Files. On that page, Add songs opens a file picker. You can also drag audio files onto the page. Playback stays on this computer. The extension does not upload those audio files to the developer or to Amazon.

The player can play and pause, seek, go to the next or previous song, shuffle, repeat, show a queue, and change volume. The list can be sorted by title or by the order songs were added, and you can search the local names. Title, artist, and cover art are read from the file in the browser.

The toolbar icon lists song names already saved and can create the empty LOCAL PLACEHOLDER playlist when it does not exist yet. That playlist is public on Amazon Music and is only an anchor. Catalog tracks that end up on it are removed. Your audio is not added to it as an Amazon upload.

File handles are kept in the browser so a file can be opened again after a reload. Audio bytes are not stored. There is no account with the developer.

English Amazon Music sites only: music.amazon.com, music.amazon.ca, music.amazon.co.uk, music.amazon.com.au, music.amazon.in, and music.amazon.ae. Not affiliated with Amazon. Amazon Music is a trademark of Amazon.com, Inc. or its affiliates.

## Category suggestion

Productivity.

If that category is not in the dashboard, use Entertainment, because the extension only runs on Amazon Music.

## Search terms

Up to seven terms, 30 characters each, 21 words total.

1. local files
2. amazon music
3. local music
4. mp3
5. flac
6. play local audio
7. own music files

## Privacy notes

What it does:

- Runs as a content script on the English Amazon Music sites listed above, plus a background service worker that stores file-system handles, and a toolbar popup.
- On the Local Files playlist page, reads audio files the user picks or drops. Reads tags and cover art from those files in the browser.
- Plays the audio locally with an audio element. Audio bytes are not written to chrome.storage and are not sent to the developer.
- Stores song names, artists, filenames, ids, and the placeholder playlist id in chrome.storage.local. Stores File System Access handles in IndexedDB (extension and page). Those handles are not audio bytes.
- Uses the Amazon Music sign-in already open in the tab to look up playlists, create a public playlist titled LOCAL PLACEHOLDER if it is missing, and remove catalog tracks from that playlist. Those requests go to Amazon Music, not to the developer. The audio files are not part of those requests.

What it does not do:

- No developer account, no sign-in to the developer, and no analytics.
- Does not upload audio to the developer and does not store audio bytes on a server.
- Does not upload the audio files to Amazon.
- Does not read the Amazon password, and does not read pages that are not Amazon Music.

Suggested privacy disclosure for the listing: this extension does not collect or transmit personal data to the developer. It reads local audio files the user picks and plays them on this computer. It does not upload those files. Creating or finding the LOCAL PLACEHOLDER playlist sends only that playlist lookup to Amazon Music, which is the site the user already has open.

## Listing fields

NAME (from manifest): Amazon Music Local Files
VERSION: 1.0.0
SHORT DESCRIPTION (from manifest description): Play audio files from this computer as a Local Files playlist anchored to an Amazon playlist named LOCAL PLACEHOLDER.

CATEGORY: Productivity
If Productivity is not in the list, use Entertainment.

WEBSITE: https://noodlesnom.github.io/local-files-for-amazon-music/
SUPPORT: https://github.com/NoodlesNom/local-files-for-amazon-music
PRIVACY POLICY URL: https://noodlesnom.github.io/local-files-for-amazon-music/privacy.html
MATURE CONTENT: No

VISIBILITY: Public
MARKETS: all markets (leave the default)

SINGLE PURPOSE:
Play audio files from this computer as a Local Files playlist on Amazon Music. It runs only on English Amazon Music. The developer does not collect personal data, and audio is not uploaded.

HOST / SITE PERMISSION JUSTIFICATION:
music.amazon.com, .ca, .co.uk, .com.au, .in, and .ae are needed so the extension can show the Local Files playlist and play files the user picked on those pages.
storage is needed for song names and the placeholder playlist id. It is not used for audio bytes.
activeTab and tabs are needed so the toolbar popup can talk to the open Amazon Music tab and so a reload can be requested when the page script must start clean.
IndexedDB file handles are kept so the user does not have to pick the same files after every reload. They are read-only handles, not copies of the audio.

REMOTE CODE: No, I am not using remote code. page-files.js is packaged with the extension.

DATA COLLECTION: This extension does not collect or transmit personal data to the developer. Do not check data-type boxes for developer collection. Audio stays on the computer. Playlist lookup and creation go only to Amazon Music to keep the empty LOCAL PLACEHOLDER anchor.

CERTIFICATIONS: Check every certification that says the extension does not sell or transfer user data to third parties outside approved use cases, does not use or transfer user data for purposes unrelated to the single purpose, and does not use or transfer user data to determine creditworthiness or for lending. Only check statements that are true. This extension collects nothing for the developer.

LOGO: icons/icon128.png in this repository. 128x128.

PACKAGE: the store zip built from the extension files at version 1.0.0. Do not include this repository's docs, and do not include any local audio.

SCREENSHOT: none. Do not invent one.

Do not submit. Do not click Submit, Publish, or Send for review.

NOTES FOR CERTIFICATION:
An Amazon Music account is required. Open Amazon Music, create or open the playlist titled LOCAL PLACEHOLDER (the page shows it as Local Files), and use Add songs to pick an audio file on the computer. The file plays in the page. It is not uploaded. The toolbar popup lists the song name only.
