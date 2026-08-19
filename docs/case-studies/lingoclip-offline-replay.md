# LingoClip Offline Song and Game Replay

## Status and claim boundary

This case study documents the internal HTTP contract observed in a captured
LingoClip web session. It is not an official or general-purpose LingoClip API
specification.

The recovered artifact is a **preserved-runtime** using the `unknown`
(inspection-first) framework route. The original classic JavaScript bundles run
locally; this is not a reconstructed `source-app`.

The capture proves one anonymous French fill-in-the-blank game for lyrics ID
`0o2A9Zm` and YouTube video ID `VHoT4N43jK8`. It does not prove arbitrary-song,
authenticated-account, billing, social-login, or live-server parity.

The captured response bodies include private account state and an access token.
`mitm-verify` reports high-severity findings. Do not serve, share, or commit the
raw capture. The reviewed local replay blocks the captured sign-in response and
uses inert `jsmap-local-*` values wherever the runtime requires an opaque token.

## Where the song data comes from

LingoClip combines two independent sources:

1. `GET /lyrics/{lyrics_id}` supplies song metadata, timed lyric lines, game
   boundaries, duration, and a YouTube video ID.
2. YouTube's player obtains the actual audio and video bytes from
   `googlevideo.com/videoplayback` responses.

The LingoClip API response does **not** contain the music. Conversely, a random
YouTube video does not contain LingoClip's timed lyric lines or fill-in-the-blank
game model.

The observed runtime flow is:

```text
POST /pre-sign
      |
      v
GET /lyrics/{id} ------> timed lines, gaps, duration, YouTube video ID
      |                                      |
      v                                      v
POST /game-pass                    local captured audio + video
      |                                      |
      +--------------> play until a gap <----+
                              |
                     pause for an answer
                              |
                    answer or skip -> resume
                              |
                  POST /user-games when saved

PUT /lyrics/{id}/hit runs independently after 20 seconds.
```

The existing LingoClip runtime owns the pause/resume and scoring behavior. The
local adapter only replaces the unavailable YouTube iframe with the exact
captured media tracks and forwards player events to that runtime.

## Transport conventions

The first-party bundle uses `https://api.lingoclip.com` as its API origin. Its
transport wrapper:

- defaults to `GET` without a request body and `POST` with one;
- JSON-encodes non-`FormData` request bodies with
  `Content-Type: application/json; charset=UTF-8`;
- adds `Authorization: Bearer <access_token>` after a session token exists;
- adds `X-Client-App-Version: <app-version>-<platform>`;
- can add `X-No-Cache: 1`, `Cache-Control: no-cache`, or a `ts` query value;
- parses successful JSON/text responses and throws an error containing the HTTP
  status and parsed error information for non-success responses.

The source was a Save-All-Resources directory tree converted to a synthetic,
GET-only HAR. Therefore, response bodies are captured evidence, but the original
request methods, bodies, and sensitive query values were not preserved. Methods
and request shapes below were recovered from control flow in
`lingoclip.app/js/app_69e3b4bd.js`; they must not be misrepresented as HAR
evidence.

## Core song and game endpoints

| Endpoint | Recovered request | Purpose and response use | Local replay classification |
| --- | --- | --- | --- |
| `/pre-sign` | `POST { "lang": "fr" }` | Creates an anonymous session. The app requires `user`, `access_token`, `user.user_id`, language, anonymous/premium flags, progress, and nullable identity fields. No response was captured for this route. | `synthetic-local-identity`; evidence-backed minimal schema with inert IDs/token. |
| `/sign-in` | `POST` with `{access_token}`, `{user,password}`, or `{with,token}` | Authenticates an existing, email, or social account and returns `user` plus `access_token`. | `blocked-private-capture`; the captured response contains a real opaque token and must never be replayed. |
| `/lyrics/{lyrics_id}` | `GET` | Returns metadata, timing, lyric/game lines, and media IDs. This is the authoritative content model for the game. | `captured-evidence`; exact reviewed song response. |
| `/favorites` | `GET ?usr={user_id}&ly={lyrics_id}&ts={time}` | Reads whether the song is a favorite. The observed response is the not-favorited state: `{error: 0, add_date: null}`. | `synthetic-local-state`; deterministic anonymous zero-state. |
| `/game-pass` | `POST {lyrics,type,mode,level}` | Starts a game and returns a pass, premium/free-limit state, games remaining, and wait time. | `synthetic-local-entitlement`; captured non-premium values with an inert local pass. |
| `/user-streak/{lang}` | `GET ?tz={IANA-zone}&ts={time}` | Reads the streak, seven daily hit values, and relative expiry. | `synthetic-local-state`; deterministic zero-state. |
| `/user-games` | `POST` game result | Saves hits, failures, skips, score, timing, words, and progress; returns game/progress updates. | `synthetic-local-mutation`; deterministic local acknowledgement, not a server write. |
| `/lyrics/{lyrics_id}/hit` | `PUT`, header `X-Game-Pass`, body `{query}` | Records a lyric view after 20 seconds. The saved resource is only a capture-tool “No Content” placeholder. | `offline-noop`; local `204`, with no analytics write. |

### Lyrics response

For the captured song, the game reads these fields:

- identity and display: `title`, `artist`, `album`, `genre`;
- language and difficulty: `lang`, `lang_cc`, `level`, `status`;
- timing and size: `num_words`, `start`, `end`, `offset`, `duration`;
- media linkage: `yt_video_id`, `mk_video_id`, `mk_video_offset`;
- catalog data: `publish_date`, `hits`;
- the timed game model: `text_lines`.

The captured response SHA-256 is
`cde8f8688e971392a0622ed90af29a0de0cce4e1ef4ead25ff91c3985944ce81`.
The replay preserves that body without reproducing its lyric text in this
document.

`text_lines` is what lets the runtime decide which words are gaps and when to
pause. Timing values are interpreted in milliseconds and aligned with the media
clock. This is why media alone is insufficient to create another game.

### Starting a fill-in-the-blank game

The captured deep link selects a Type game:

```json
{
  "lyrics": "0o2A9Zm",
  "type": "fitb",
  "mode": "tp",
  "level": "b1"
}
```

Observed modes are:

- `tp`: type the missing word;
- `mc`: choose the missing word from multiple choices.

The `/game-pass` response fields used by the app are `game_pass`, `premium`,
`free_limit`, `games_left`, and `wait_time`. The capture's opaque pass is not
safe to reuse. The reviewed fixture substitutes a value beginning with
`jsmap-local-` while retaining the captured free/non-premium behavior.

### Saving a game

The runtime queues a `/user-games` write after at least one hit or failure. The
request is assembled from fields including:

`lyrics_id`, `type`, `mode`, `level`, `lang`, `progress`, `score`, `hits`,
`fails`, `skips`, `gaps`, `life`, `time`, `stars`, `words`, `user_id`, and an
elapsed `timestamp`. A challenge ID can also be present.

The captured response shape includes a game ID, retry/best counters,
vocabulary, date, and a `progress_update` object. Offline replay returns a
sanitized deterministic shape. It does not persist account progress or claim a
successful live write.

## Other routes found in the bundle

These routes were observed in first-party JavaScript but were not covered well
enough by this capture to claim offline parity:

- `GET /leaders` with song/game/challenge/country filters;
- `GET /user-games/{game_id}` for a previously saved game;
- `POST /challenges` and `GET /challenges/{id}`;
- `GET /exercises/{id}`;
- account routes such as `/sign-up`, `/user/{id}`, email verification, password
  reset, profile pictures, and account deletion.

Treat these as inspection evidence, not tested replay support.

## Captured YouTube media

The capture contains 52 YouTube SABR/UMP `videoplayback` response envelopes.
Their request queries and bodies were lost, so pathname replay cannot reliably
select the right fragment. `replay-ump` instead parses the UMP media headers,
validates every declared content length and byte range, groups fragments by
video ID and itag, and writes exact reassembled tracks plus
`UMP_MEDIA_PROVENANCE.json`.

```bash
node scripts/jsmap.cjs replay-ump <saved-resource-dir> \
  <recovery-dir>/recovery/replay-media
```

For `VHoT4N43jK8`, the validated result is:

| Track | Captured format | Bytes | SHA-256 | Captured duration evidence |
| --- | --- | ---: | --- | ---: |
| Audio, itag 251 | Opus in WebM | 4,088,257 | `01352d17823b344cebfae00c5a989b1314d7e89f78aad024c5f51498aa43cc63` | about 234.801 s |
| Video, itag 396 | AV1 fragmented MP4 | 7,453,761 | `137e6b87b92331901ddf3693967cdd068b5643e0f6c89be870952ab462b0f3ec` | about 234.720 s |

The files are not transcoded or muxed. The replay harness serves them with byte
range support, and the adapter keeps the separate audio and video elements on a
shared clock.

## Reviewed replay policy

`harness --replay-policy` accepts an approved policy that keeps captured,
synthetic, private, and no-op behavior explicit. A policy must have:

- `version: 1`;
- `strictOffline: true` for this case;
- an approved review containing `reviewer` and `reviewedAt`;
- a method, origin, path, approved `kind`, and
  `containsPrivateData: false` for every local response;
- inert `jsmap-local-*` values for `access_token` and `game_pass`;
- captured media paths and verified SHA-256 values;
- a blocked-route entry for the captured private sign-in response.

Minimal shape (values abbreviated):

```json
{
  "version": 1,
  "strictOffline": true,
  "review": {
    "status": "approved",
    "reviewer": "human-reviewer",
    "reviewedAt": "2026-08-19T00:00:00.000Z"
  },
  "responses": [
    {
      "method": "POST",
      "origin": "https://api.lingoclip.com",
      "path": "/pre-sign",
      "status": 200,
      "kind": "synthetic-local-identity",
      "containsPrivateData": false,
      "body": {
        "error": 0,
        "access_token": "jsmap-local-anonymous-session"
      }
    }
  ],
  "blockedCapturedRoutes": [
    {
      "origin": "https://api.lingoclip.com",
      "path": "/sign-in"
    }
  ],
  "youtube": [
    {
      "videoId": "VHoT4N43jK8",
      "kind": "captured-media",
      "videoFile": "replay-media/video.mp4",
      "audioFile": "replay-media/audio.webm",
      "videoSha256": "<verified-sha256>",
      "audioSha256": "<verified-sha256>",
      "videoMime": "video/mp4",
      "audioMime": "audio/webm",
      "durationMs": 235000
    }
  ]
}
```

The abbreviated example is explanatory, not a ready-to-run fixture. The actual
`/pre-sign` response must include the minimal user fields required by the
runtime, and every selected response must be reviewed for private data.

Generate the harness only after that review:

```bash
node scripts/jsmap.cjs harness <recovery-dir> \
  --framework unknown \
  --replay-policy <reviewed-policy.json>
cd <recovery-dir>
npm run serve
```

Use the main SPA shell for the song route. The saved
`/lyrics/0o2A9Zm.html` is a separate marketing/store handoff page, while the
bundle supports an encoded startup path:

```text
/?path=%2Flyrics%2F0o2A9Zm%3Fmode%3Dtp%26level%3Db1
```

## What was tested

Browser interaction verified both captured fill-in-the-blank modes:

- Type (`tp`): playback paused at a word gap; Skip reduced remaining gaps and
  resumed playback.
- Choice (`mc`): playback paused at a word gap; selecting the correct answer
  incremented hits, reduced remaining gaps, and resumed playback.
- The local video rendered nonblank frames; separate audio/video tracks advanced
  with about 0.06 seconds of observed clock difference.

This is functional evidence for the captured song, not a universal guarantee.
Two non-core external initialization errors remained from blocked Firebase
analytics/purchase startup, so the run must not be described as console-clean.
Human listening remains the final checkpoint for audible quality and perceived
sync.

## Adding another song or video

Another LingoClip song can work only if the evidence set is complete:

1. Capture and review that song's `GET /lyrics/{id}` response, including its
   timed `text_lines` and media ID.
2. Capture the complete YouTube UMP media session for that media ID.
3. Run `replay-ump` and require contiguous, hash-verified audio and video output.
4. Add an explicit, reviewed video-ID-to-track mapping to the replay policy.
5. Block or replace any private identity, entitlement, favorite, streak, and
   game-save responses with labeled local fixtures.
6. Test pause, answer, skip, resume, seek, duration, audio/video sync, network
   isolation, and console errors in a browser.
7. Have a human listen and confirm that the displayed song, lyrics, and audio
   actually correspond.

Supplying only a new YouTube URL is not enough. Without LingoClip's timed lyric
model, generating gaps or synchronization would be new synthetic behavior rather
than recovered behavior. Without complete captured media, the runtime would need
live YouTube access and would no longer be a deterministic offline replay.

## Evidence references

- First-party runtime: `lingoclip.app/js/app_69e3b4bd.js` (observed app version
  2.8.0).
- Imported HTTP evidence: `.jsmap-mitm/ROUTE_MAP.json` and content-addressed
  bodies, kept outside the served application.
- Media evidence: `recovery/replay-media/UMP_MEDIA_PROVENANCE.json`.
- Captured response hashes used during review:
  - sign-in schema (private, blocked):
    `7be80ecb80f987c62680530205fc4e55f09f245f2746e21f2cc9a9bde43ee52a`;
  - favorites:
    `43a31c989538c8c4884fd955c068638451388ff69320f32cce2d9d7a2d3ae4b1`;
  - game pass:
    `eeebeb436a637d78fd8a5f26d3b7683ff6a5be36511de095d0fe72dd53f6b563`;
  - user streak:
    `5b3f57d84166de144f59ca99d8b96476917852f88cf96957f8ce8110e2725fba`;
  - game save:
    `4486cd246773e0f598554e12c548528e52f4f0cbc5e6cc694685f4f0d275351e`.

Hashes identify reviewed evidence without publishing the response contents.
