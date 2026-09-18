# Reviewed public help videos

Videos are public tutorial artifacts, kept under `landing/help-videos/` so the app build and service-worker cache do not acquire them. The static package copies only the approved MP4, JPEG poster, WebVTT captions and text transcript to `/help/videos/<id>/`.

## Review boundary

No video is advertised because a draft happens to exist. `scripts/help-videos.mjs` requires a portable `landing/help-videos/manifest.json` with publication approval, visual and playback review for each tutorial, a review timestamp and reviewer, the source revision, and SHA-256 hashes for all four files. Missing or changed bytes fail the build. No manifest means the existing written guides remain available and the page says videos are not yet available.

The review records a real check performed by the release owner. The validator cannot replace watching the recording and listening to it. Do not create approval metadata merely to make a build pass.

Example shape (placeholders must be replaced with verified values):

```json
{
  "schemaVersion": 1,
  "status": "approved_for_publication",
  "tutorials": [{
    "id": "first-license",
    "title": "First license",
    "status": "approved_for_publication",
    "sourceRevision": "2c28f87a",
    "durationSeconds": 50,
    "width": 1920,
    "height": 1080,
    "demoLabel": true,
    "burnedCaptions": true,
    "review": {
      "visual": true,
      "playback": true,
      "videoSHA256": "<same SHA-256 as files.video>",
      "reviewedAt": "<actual ISO timestamp>",
      "reviewedBy": "<actual reviewer>"
    },
    "files": {
      "video": {"file": "first-license/tutorial.mp4", "sha256": "<64 lowercase hex characters>"},
      "poster": {"file": "first-license/poster.jpg", "sha256": "<64 lowercase hex characters>"},
      "captions": {"file": "first-license/captions.vtt", "sha256": "<64 lowercase hex characters>"},
      "transcript": {"file": "first-license/transcript.txt", "sha256": "<64 lowercase hex characters>"}
    }
  }]
}
```

Supported IDs are the fourteen shared written-guide IDs, including `share-references` and `share-documents`. All guide prose, evidence and support-use policy live in `public/knowledge/credentialdo-help.json`. Written guides remain available before their videos have been reviewed. A partial catalog is allowed; it advertises only its approved tutorials.

## Integrate and verify

1. Obtain the media release manifest after the owner has reviewed actual visual captures, narration/captions and playback. Verify source asset hashes against that release manifest.
2. Copy only its four approved assets per tutorial to the canonical names above. Keep local capture paths, raw audio, draft HTML players, unused variants and review working files outside the site.
3. Write the portable catalog preserving the real review evidence and hashes.
4. Run `node scripts/build-help.mjs` and the help-content/help-video/site-packaging tests. The packager checks that generated help exactly matches the approved catalog before replacing its output.
5. Review the final public-page players in a browser, on desktop and mobile. Confirm keyboard controls, the native captions option, transcript/download links, no autoplay, that opening one video pauses another, and that search/category filters pause any player they hide. Confirm the videos remain outside `/app/` and the PWA cache list.

Players use `preload="none"`, local posters, native controls and `playsinline`. Narrated demonstrations retain visible DEMO DATA/no-live-send disclosures. If captions are already burned into the approved picture, the optional native track is available without being forced on twice; otherwise the English captions track is on by default. Every video has a text transcript. Closing a guide pauses its video.

The release does not turn on billing, support automation, portal access, email delivery or a provider. Videos demonstrate source UI using synthetic data; they do not establish credential validity, regulatory compliance, a delivery result or live service availability.

## Current fourteen-video release

The release owner approved visual review and full browser playback of all fourteen final video hashes. Audio verification used automated signal checks and comparison with narration inputs. `manualListening: false` is preserved in each review record; this release does not claim that a person listened to every narration. `review.videoSHA256` must exactly match `files.video.sha256`, so a new encoding cannot inherit playback approval for different bytes.
