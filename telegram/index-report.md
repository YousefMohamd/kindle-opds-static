# Index report — telegram-book-index

**Date:** 2026-11-07T14:02:58.485529+00:00 — **Status:** ok — **Mode:** backfill — **Duration:** 2h
**Config:** `channels.yaml` — **DB:** `index.db`
**Method:** public t.me/s/ previews only, page by page, metadata only (post text, file name/format/size, post link). No API, no login, no account. Book files are never downloaded.
**Note:** Backfill: one block of 3000 posts per channel below the oldest indexed post; a channel is complete when a block reaches post 1 or returns fewer than 3000 posts.

## Summary so far
- **Channels with data: 51 of 51 walkable** — **111313 posts, 30858 book files** (26814 distinct books)
- **Channels with 0 book files: 8** (drop candidates — see below)
- **Dropped channels: 8** (0 book files in the full first run — history kept in the DB, no longer fetched; see below)
- **Low-density channels: 3** (fewer than 1 book file per 100 posts — kept active, see below)
- **Not yet indexed: 0 channels**
- **Failures this run: 0** (see below; a failed channel keeps its last-good data)
- **Groups indexed from exports: 0** — 168 more groups are commented out in channels.yaml, each needs a Desktop JSON export

## This run
| Channel | New posts | New book files | Scope |
|---|---|---|---|
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 0 | 0 | backfill — complete |
| [alnoorlib](https://t.me/alnoorlib) | 0 | 0 | backfill — complete |
| [daownbook](https://t.me/daownbook) | 0 | 0 | backfill — complete |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 0 | 0 | backfill — complete |
| [kindlbook](https://t.me/kindlbook) | 0 | 0 | backfill — complete |
| [Kindle2](https://t.me/Kindle2) | 0 | 0 | backfill — complete |
| [darkromancenovels](https://t.me/darkromancenovels) | 3 | 0 | backfill — complete |
| [thedevilshours](https://t.me/thedevilshours) | 1 | 0 | backfill — complete |
| [TheEbookStop](https://t.me/TheEbookStop) | 0 | 0 | backfill — complete |
| [ekraly](https://t.me/ekraly) | 3001 | 27 | backfill — more remain |
| [L_alnader8](https://t.me/L_alnader8) | 3001 | 13 | backfill — more remain |
| [osratouna1](https://t.me/osratouna1) | 1953 | 34 | backfill — complete |
| [rwaiaty4](https://t.me/rwaiaty4) | 3000 | 2661 | backfill — more remain |
| [AAT2024F](https://t.me/AAT2024F) | 0 | 0 | backfill — complete |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 0 | 0 | backfill — complete |
| [eatae](https://t.me/eatae) | 904 | 104 | backfill — complete |
| [altfwok](https://t.me/altfwok) | 3014 | 195 | backfill — more remain |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 0 | 0 | backfill — complete |
| [alm_elmaref](https://t.me/alm_elmaref) | 2489 | 1775 | backfill — complete |
| [arabicbooks](https://t.me/arabicbooks) | 1775 | 458 | backfill — complete |
| [book_juice](https://t.me/book_juice) | 1808 | 165 | backfill — complete |
| [book_lovers_s](https://t.me/book_lovers_s) | 3000 | 2942 | backfill — more remain |
| [books_p](https://t.me/books_p) | 3000 | 541 | backfill — more remain |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 3000 | 191 | backfill — more remain |
| [maktabahzahra](https://t.me/maktabahzahra) | 3000 | 36 | backfill — more remain |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | backfill — complete |
| [nourbook](https://t.me/nourbook) | 362 | 0 | backfill — complete |
| [roayati](https://t.me/roayati) | 521 | 0 | backfill — complete |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | backfill — complete |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | backfill — complete |
| [twinkling4](https://t.me/twinkling4) | 921 | 287 | backfill — complete |
| [your_books](https://t.me/your_books) | 126 | 0 | backfill — complete |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3000 | 244 | backfill — more remain |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | backfill — complete |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | backfill — complete |
| [jad32](https://t.me/jad32) | 192 | 109 | backfill — complete |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 20 | 0 | backfill — complete |
| [boook1023](https://t.me/boook1023) | 3000 | 4 | backfill — more remain |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 3000 | 1469 | backfill — more remain |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | backfill — complete |
| [Ouloalelm](https://t.me/Ouloalelm) | 278 | 85 | backfill — complete |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | backfill — complete |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | backfill — complete |

## Backfill status

Each backfill run walks one block (3000 posts by default) below the oldest indexed post of every not-yet-complete channel, newest first. A channel is complete when a block reaches post 1 or returns fewer than the block size (the preview is exhausted). Once every channel is complete, backfill runs only check for new posts — the same as `--new-only` — and the workflow can be switched to it.

- [KindleBooksRepository](https://t.me/KindleBooksRepository) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [alnoorlib](https://t.me/alnoorlib) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [daownbook](https://t.me/daownbook) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [kindlbook](https://t.me/kindlbook) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Kindle2](https://t.me/Kindle2) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [darkromancenovels](https://t.me/darkromancenovels) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [thedevilshours](https://t.me/thedevilshours) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [TheEbookStop](https://t.me/TheEbookStop) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [ekraly](https://t.me/ekraly) — block: 3000 posts, oldest reached 136970, more remain
  Backfill block: 3000 posts; oldest reached 136970. More remain — the next run continues below post 136970.
- [L_alnader8](https://t.me/L_alnader8) — block: 3000 posts, oldest reached 26613, more remain
  Backfill block: 3000 posts; oldest reached 26613. More remain — the next run continues below post 26613.
- [osratouna1](https://t.me/osratouna1) — block: 1947 posts, oldest reached 1, complete
  Backfill block: 1947 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [rwaiaty4](https://t.me/rwaiaty4) — block: 3000 posts, oldest reached 41071, more remain
  Backfill block: 3000 posts; oldest reached 41071. More remain — the next run continues below post 41071.
- [AAT2024F](https://t.me/AAT2024F) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [eatae](https://t.me/eatae) — block: 904 posts, oldest reached 1, complete
  Backfill block: 904 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [altfwok](https://t.me/altfwok) — block: 3000 posts, oldest reached 11051, more remain
  Backfill block: 3000 posts; oldest reached 11051. More remain — the next run continues below post 11051.
- [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [alm_elmaref](https://t.me/alm_elmaref) — block: 2489 posts, oldest reached 1, complete
  Backfill block: 2489 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [arabicbooks](https://t.me/arabicbooks) — block: 1775 posts, oldest reached 1, complete
  Backfill block: 1775 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [book_juice](https://t.me/book_juice) — block: 1808 posts, oldest reached 1, complete
  Backfill block: 1808 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [book_lovers_s](https://t.me/book_lovers_s) — block: 3000 posts, oldest reached 7396, more remain
  Backfill block: 3000 posts; oldest reached 7396. More remain — the next run continues below post 7396.
- [books_p](https://t.me/books_p) — block: 3000 posts, oldest reached 8074, more remain
  Backfill block: 3000 posts; oldest reached 8074. More remain — the next run continues below post 8074.
- [HAYA_NAQRA](https://t.me/HAYA_NAQRA) — block: 3000 posts, oldest reached 1618, more remain
  Backfill block: 3000 posts; oldest reached 1618. More remain — the next run continues below post 1618.
- [maktabahzahra](https://t.me/maktabahzahra) — block: 3000 posts, oldest reached 11757, more remain
  Backfill block: 3000 posts; oldest reached 11757. More remain — the next run continues below post 11757.
- [n_bhs2](https://t.me/n_bhs2) — block: 2 posts, oldest reached 1, complete
  Backfill block: 2 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [nourbook](https://t.me/nourbook) — block: 362 posts, oldest reached 1, complete
  Backfill block: 362 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [roayati](https://t.me/roayati) — block: 521 posts, oldest reached 1, complete
  Backfill block: 521 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [sharkelmoreeg](https://t.me/sharkelmoreeg) — block: 2 posts, oldest reached 1, complete
  Backfill block: 2 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Sumarians](https://t.me/Sumarians) — block: 52 posts, oldest reached 1, complete
  Backfill block: 52 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [twinkling4](https://t.me/twinkling4) — block: 921 posts, oldest reached 1, complete
  Backfill block: 921 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [your_books](https://t.me/your_books) — block: 126 posts, oldest reached 1, complete
  Backfill block: 126 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [ahmedsalem81](https://t.me/ahmedsalem81) — block: 3000 posts, oldest reached 505, more remain
  Backfill block: 3000 posts; oldest reached 505. More remain — the next run continues below post 505.
- [ktbibnalqaim](https://t.me/ktbibnalqaim) — block: 1713 posts, oldest reached 1, complete
  Backfill block: 1713 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [qurany_is_life](https://t.me/qurany_is_life) — block: 99 posts, oldest reached 1, complete
  Backfill block: 99 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [jad32](https://t.me/jad32) — block: 192 posts, oldest reached 1, complete
  Backfill block: 192 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Merciful111Fate](https://t.me/Merciful111Fate) — block: 20 posts, oldest reached 1, complete
  Backfill block: 20 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [boook1023](https://t.me/boook1023) — block: 3000 posts, oldest reached 16346, more remain
  Backfill block: 3000 posts; oldest reached 16346. More remain — the next run continues below post 16346.
- [Goldenshamelaepub](https://t.me/Goldenshamelaepub) — block: 3000 posts, oldest reached 27724, more remain
  Backfill block: 3000 posts; oldest reached 27724. More remain — the next run continues below post 27724.
- [kindlearabicbook](https://t.me/kindlearabicbook) — block: 1059 posts, oldest reached 1, complete
  Backfill block: 1059 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Ouloalelm](https://t.me/Ouloalelm) — block: 278 posts, oldest reached 1, complete
  Backfill block: 278 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Course_reserve](https://t.me/Course_reserve) — block: 172 posts, oldest reached 1, complete
  Backfill block: 172 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [zamerican0english](https://t.me/zamerican0english) — block: 1039 posts, oldest reached 1, complete
  Backfill block: 1039 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.

Complete this run: 32 of 43 channels touched.

## Indexed channels (51)

| Channel | Posts | Book files | Scope |
|---|---|---|---|
| [AAT2024F](https://t.me/AAT2024F) | 11 | 0 | backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3000 | 244 | backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 5489 | 3052 | backfill |
| [alnoorlib](https://t.me/alnoorlib) | 202 | 38 | backfill |
| [altfwok](https://t.me/altfwok) | 6014 | 675 | backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 1469 | 14 | backfill |
| [arabicbooks](https://t.me/arabicbooks) | 4775 | 694 | backfill |
| [arabicEread](https://t.me/arabicEread) | 3 | 0 | — |
| [book_juice](https://t.me/book_juice) | 4808 | 226 | backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 6000 | 5146 | backfill |
| [Bookkn](https://t.me/Bookkn) | 5 | 0 | — |
| [books_p](https://t.me/books_p) | 3000 | 541 | backfill |
| [booksguy](https://t.me/booksguy) | 2 | 0 | — |
| [boook1023](https://t.me/boook1023) | 3000 | 4 | backfill |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | backfill |
| [daownbook](https://t.me/daownbook) | 3679 | 1794 | backfill |
| [darkromancenovels](https://t.me/darkromancenovels) | 5071 | 1053 | backfill |
| [eatae](https://t.me/eatae) | 3904 | 386 | backfill |
| [eBookRoom](https://t.me/eBookRoom) | 1670 | 0 | — |
| [Ebookspdfdownload](https://t.me/Ebookspdfdownload) | 2 | 0 | — |
| [ekraly](https://t.me/ekraly) | 6001 | 67 | backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 3000 | 1469 | backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 3000 | 191 | backfill |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 1182 | 1605 | backfill |
| [jad32](https://t.me/jad32) | 192 | 109 | backfill |
| [kindlbook](https://t.me/kindlbook) | 2983 | 1473 | backfill |
| [Kindle2](https://t.me/Kindle2) | 534 | 19 | backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | backfill |
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 6220 | 3293 | backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | backfill |
| [L_alnader8](https://t.me/L_alnader8) | 6001 | 292 | backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 3000 | 36 | backfill |
| [Maktademia](https://t.me/Maktademia) | 1 | 0 | — |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 1718 | 1 | backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 20 | 0 | backfill |
| [Motamayezon7](https://t.me/Motamayezon7) | 65 | 0 | — |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | backfill |
| [nourbook](https://t.me/nourbook) | 362 | 0 | backfill |
| [osratouna1](https://t.me/osratouna1) | 4953 | 125 | backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 278 | 85 | backfill |
| [premium_ebooks](https://t.me/premium_ebooks) | 1172 | 0 | — |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | backfill |
| [roayati](https://t.me/roayati) | 521 | 0 | backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 6000 | 5162 | backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | backfill |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | backfill |
| [thedevilshours](https://t.me/thedevilshours) | 2009 | 169 | backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 4812 | 1568 | backfill |
| [twinkling4](https://t.me/twinkling4) | 921 | 287 | backfill |
| [your_books](https://t.me/your_books) | 126 | 0 | backfill |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | backfill |

## Channels with 0 book files — drop candidates (8)

- [AAT2024F](https://t.me/AAT2024F) — 11 posts, 0 book files
- [Merciful111Fate](https://t.me/Merciful111Fate) — 20 posts, 0 book files
- [n_bhs2](https://t.me/n_bhs2) — 2 posts, 0 book files
- [nourbook](https://t.me/nourbook) — 362 posts, 0 book files
- [roayati](https://t.me/roayati) — 521 posts, 0 book files
- [sharkelmoreeg](https://t.me/sharkelmoreeg) — 2 posts, 0 book files
- [Sumarians](https://t.me/Sumarians) — 52 posts, 0 book files
- [your_books](https://t.me/your_books) — 126 posts, 0 book files

## Dropped channels (8)

Removed from the active config after the full first run (2026-11-06): 0 book files each. Their history stays in index.db and remains searchable; they are simply not fetched anymore. To re-add one, move its line back to `channels:` in channels.yaml.

- [Bookkn](https://t.me/Bookkn) — 5 posts, 0 book files
- [Ebookspdfdownload](https://t.me/Ebookspdfdownload) — 2 posts, 0 book files
- [Maktademia](https://t.me/Maktademia) — 1 post, 0 book files
- [Motamayezon7](https://t.me/Motamayezon7) — 65 posts, 0 book files
- [arabicEread](https://t.me/arabicEread) — 3 posts, 0 book files
- [booksguy](https://t.me/booksguy) — 2 posts, 0 book files
- [eBookRoom](https://t.me/eBookRoom) — 1670 posts, 0 book files
- [premium_ebooks](https://t.me/premium_ebooks) — 1172 posts, 0 book files

## Low-density channels (3)

Kept active, but they yield fewer than 1 book file per 100 posts — they cost walk time for almost no books. If a channel here stays this sparse, it is the next drop candidate.

- [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) — 1469 posts, 14 book files (0.010 files/post)
- [boook1023](https://t.me/boook1023) — 3000 posts, 4 book files (0.001 files/post)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — 1718 posts, 1 book files (0.001 files/post)

## Giants (uncapped walk is impractical)

- [Sumarians](https://t.me/Sumarians) — newest post id 306117 ≈ ~8.5h for a full walk (indexed 52 posts, oldest reached 1)
- [roayati](https://t.me/roayati) — newest post id 289090 ≈ ~8.0h for a full walk (indexed 521 posts, oldest reached 1)
- [ekraly](https://t.me/ekraly) — newest post id 211455 ≈ ~5.9h for a full walk (indexed 6001 posts, oldest reached 136970)
- [L_alnader8](https://t.me/L_alnader8) — newest post id 80303 ≈ ~2.2h for a full walk (indexed 6001 posts, oldest reached 26613)
- [rwaiaty4](https://t.me/rwaiaty4) — newest post id 54290 ≈ ~1.5h for a full walk (indexed 6000 posts, oldest reached 41071)

## What failed so far

Nothing failed on this run.

## Not yet indexed — remaining 0 channels

None — every channel in the config has been indexed.

## Not indexable live — groups (need a Desktop JSON export each)

Reason: public groups have no t.me/s/ preview, so live scraping is impossible. Each group needs a Telegram Desktop 'Export chat history' as JSON (result.json), then its entry is uncommented in channels.yaml. No export has been produced yet for most groups.


Pending exports (168 groups, commented out in channels.yaml):

- [All_kinds_Books_Lib](https://t.me/All_kinds_Books_Lib)
- [Arabickindle1](https://t.me/Arabickindle1)
- [BOOKCLUB_AR](https://t.me/BOOKCLUB_AR)
- [bookclubarabic](https://t.me/bookclubarabic)
- [booksforarabs](https://t.me/booksforarabs)
- [ddfkindle](https://t.me/ddfkindle)
- [EBook_Library](https://t.me/EBook_Library)
- [jazz223k](https://t.me/jazz223k)
- [kfxarabic](https://t.me/kfxarabic)
- [kindel4](https://t.me/kindel4)
- [kindle4kurd](https://t.me/kindle4kurd)
- [KindleArabicLibrary](https://t.me/KindleArabicLibrary)
- [KindleKotob](https://t.me/KindleKotob)
- [kotobkhana](https://t.me/kotobkhana)
- [pdfiat](https://t.me/pdfiat)
- [xepub](https://t.me/xepub)
- [BOOK_HOUSE_INTERNATIONAL](https://t.me/BOOK_HOUSE_INTERNATIONAL)
- [bookjunkieb](https://t.me/bookjunkieb)
- [bookpdfepub](https://t.me/bookpdfepub)
- [bookspsychology101](https://t.me/bookspsychology101)
- [CoolBooks](https://t.me/CoolBooks)
- [e_books_eng](https://t.me/e_books_eng)
- [ebookstoread](https://t.me/ebookstoread)
- [englishbooks99](https://t.me/englishbooks99)
- [FreeEbookDownloadEnglish](https://t.me/FreeEbookDownloadEnglish)
- [Legacy_1945](https://t.me/Legacy_1945)
- [muscatnonfiction](https://t.me/muscatnonfiction)
- [OnePageAway](https://t.me/OnePageAway)
- [oxford_bookworms_lm](https://t.me/oxford_bookworms_lm)
- [Oxford_Bookwormss](https://t.me/Oxford_Bookwormss)
- [OxfordBookwormers](https://t.me/OxfordBookwormers)
- [OxfordBookwormsDominoes1](https://t.me/OxfordBookwormsDominoes1)
- [OxfordReadingTree](https://t.me/OxfordReadingTree)
- [storybookspdf](https://t.me/storybookspdf)
- [the_romance_hub](https://t.me/the_romance_hub)
- [trunkietrunk](https://t.me/trunkietrunk)
- [adventurers5](https://t.me/adventurers5)
- [Ahlahadota](https://t.me/Ahlahadota)
- [almoghmiroonal5msa](https://t.me/almoghmiroonal5msa)
- [Arabic_PDF](https://t.me/Arabic_PDF)
- [bookcheldren](https://t.me/bookcheldren)
- [Mahmoud_Salem_5](https://t.me/Mahmoud_Salem_5)
- [maktph](https://t.me/maktph)
- [noorlibrarykids](https://t.me/noorlibrarykids)
- [pokidz](https://t.me/pokidz)
- [samaheltaweelkidsstories](https://t.me/samaheltaweelkidsstories)
- [Comics_gate](https://t.me/Comics_gate)
- [comics_link](https://t.me/comics_link)
- [donaldduckcomics](https://t.me/donaldduckcomics)
- [Mohanime](https://t.me/Mohanime)
- [BabyEnglishBooks](https://t.me/BabyEnglishBooks)
- [book4kid](https://t.me/book4kid)
- [stories_kids](https://t.me/stories_kids)
- [storybooksforkids](https://t.me/storybooksforkids)
- [audiobooks_kid](https://t.me/audiobooks_kid)
- [easymath121](https://t.me/easymath121)
- [G5_Y5](https://t.me/G5_Y5)
- [kidsbookden](https://t.me/kidsbookden)
- [plussheets](https://t.me/plussheets)
- [sciencecamp1](https://t.me/sciencecamp1)
- [scincematerialsMH](https://t.me/scincematerialsMH)
- [ArabicMagazine](https://t.me/ArabicMagazine)
- [arabJournalism](https://t.me/arabJournalism)
- [magazineguy](https://t.me/magazineguy)
- [megalatnawader](https://t.me/megalatnawader)
- [aa2tyuq](https://t.me/aa2tyuq)
- [abo_abdu](https://t.me/abo_abdu)
- [ahn1972](https://t.me/ahn1972)
- [ahn2323](https://t.me/ahn2323)
- [alanbyawardmsr](https://t.me/alanbyawardmsr)
- [almaktbhh](https://t.me/almaktbhh)
- [Almootnbe100](https://t.me/Almootnbe100)
- [art_of_book](https://t.me/art_of_book)
- [ArwaCoffeeBook](https://t.me/ArwaCoffeeBook)
- [asseralkotob](https://t.me/asseralkotob)
- [book100100](https://t.me/book100100)
- [book350](https://t.me/book350)
- [Book_cr2](https://t.me/Book_cr2)
- [Bookes2023](https://t.me/Bookes2023)
- [bookforbooks](https://t.me/bookforbooks)
- [BoOkJuiCe](https://t.me/BoOkJuiCe)
- [books2023](https://t.me/books2023)
- [BROKAREEMANDME](https://t.me/BROKAREEMANDME)
- [cozmoBooks](https://t.me/cozmoBooks)
- [debsibooks](https://t.me/debsibooks)
- [DrKhaledFahmy](https://t.me/DrKhaledFahmy)
- [ekraly3](https://t.me/ekraly3)
- [freebooksf](https://t.me/freebooksf)
- [fun_to_read](https://t.me/fun_to_read)
- [HadiAriyanLibrary](https://t.me/HadiAriyanLibrary)
- [HindawiFoundationBooks](https://t.me/HindawiFoundationBooks)
- [HoSo0oN](https://t.me/HoSo0oN)
- [julietyoya](https://t.me/julietyoya)
- [katabataa](https://t.me/katabataa)
- [khatabg](https://t.me/khatabg)
- [KotobkhanaPDF](https://t.me/KotobkhanaPDF)
- [kotokhatab](https://t.me/kotokhatab)
- [kottobgededa1977](https://t.me/kottobgededa1977)
- [L_alnader1](https://t.me/L_alnader1)
- [L_alnader14](https://t.me/L_alnader14)
- [l_alnader2](https://t.me/l_alnader2)
- [lastStopbooks](https://t.me/lastStopbooks)
- [lenaqra](https://t.me/lenaqra)
- [lenaqra3](https://t.me/lenaqra3)
- [llllTTTWW](https://t.me/llllTTTWW)
- [lovekotob](https://t.me/lovekotob)
- [M3RFAHALKOTOB](https://t.me/M3RFAHALKOTOB)
- [MaktabaBook](https://t.me/MaktabaBook)
- [maktbahnet](https://t.me/maktbahnet)
- [maktbapdf](https://t.me/maktbapdf)
- [mybook22](https://t.me/mybook22)
- [ni3mehalzoubi](https://t.me/ni3mehalzoubi)
- [novels2n](https://t.me/novels2n)
- [Numidia_Library](https://t.me/Numidia_Library)
- [pdf_novels](https://t.me/pdf_novels)
- [pdfkotab19](https://t.me/pdfkotab19)
- [read00](https://t.me/read00)
- [Sa7eralkutub](https://t.me/Sa7eralkutub)
- [soramnqraa](https://t.me/soramnqraa)
- [tea_sugar](https://t.me/tea_sugar)
- [To_The_Book](https://t.me/To_The_Book)
- [wadistreambooks](https://t.me/wadistreambooks)
- [wessam_pdf](https://t.me/wessam_pdf)
- [yasmeenbook](https://t.me/yasmeenbook)
- [abntaymia3](https://t.me/abntaymia3)
- [almeshkat2023](https://t.me/almeshkat2023)
- [baz_book](https://t.me/baz_book)
- [Drnonaphrmacy](https://t.me/Drnonaphrmacy)
- [dvjhtj](https://t.me/dvjhtj)
- [Free_IslamicBooks](https://t.me/Free_IslamicBooks)
- [IslamicLibrary1](https://t.me/IslamicLibrary1)
- [islamicMoral](https://t.me/islamicMoral)
- [kj7_oi](https://t.me/kj7_oi)
- [KOTOB_ISLAMIC](https://t.me/KOTOB_ISLAMIC)
- [KotobEslamiah](https://t.me/KotobEslamiah)
- [ktbmB_othaimen](https://t.me/ktbmB_othaimen)
- [ktbmfid](https://t.me/ktbmfid)
- [mergebooks](https://t.me/mergebooks)
- [NewBooksAndEditions](https://t.me/NewBooksAndEditions)
- [palkotob](https://t.me/palkotob)
- [PDFnew](https://t.me/PDFnew)
- [qra_at](https://t.me/qra_at)
- [quwaa](https://t.me/quwaa)
- [safi_book](https://t.me/safi_book)
- [tahmilkutubwarosaililmiyah](https://t.me/tahmilkutubwarosaililmiyah)
- [jame3_masahif](https://t.me/jame3_masahif)
- [shamarly](https://t.me/shamarly)
- [abjjad_free](https://t.me/abjjad_free)
- [julietbookstoregroup](https://t.me/julietbookstoregroup)
- [K3tabi](https://t.me/K3tabi)
- [K3tabiCo](https://t.me/K3tabiCo)
- [Motamayz00n](https://t.me/Motamayz00n)
- [READ4OR](https://t.me/READ4OR)
- [Rff404](https://t.me/Rff404)
- [SARIQriwayat](https://t.me/SARIQriwayat)
- [GoldenshamelaGroup](https://t.me/GoldenshamelaGroup)
- [isalmickindl](https://t.me/isalmickindl)
- [shamela4kindle](https://t.me/shamela4kindle)
- [shamela_epub](https://t.me/shamela_epub)
- [shamela_kindle](https://t.me/shamela_kindle)
- [ShamelaMakhtota](https://t.me/ShamelaMakhtota)
- [cambridge_library](https://t.me/cambridge_library)
- [englishcafe_1](https://t.me/englishcafe_1)
- [langcours](https://t.me/langcours)
- [MyEnglishChannel](https://t.me/MyEnglishChannel)
- [Tleeq](https://t.me/Tleeq)
- [ZAmericanEnglishCourse](https://t.me/ZAmericanEnglishCourse)
- [zamericangroup](https://t.me/zamericangroup)

## Dead — 10 handles that do not exist (verified on two probes)

- [KOTOBPDFFF](https://t.me/KOTOBPDFFF)
- [mystery_books_ar](https://t.me/mystery_books_ar)
- [pdfdone](https://t.me/pdfdone)
- [eltabry_books](https://t.me/eltabry_books)
- [fffghllhhhgd](https://t.me/fffghllhhhgd)
- [GedoLibrary](https://t.me/GedoLibrary)
- [Old_Mag_Unindexed](https://t.me/Old_Mag_Unindexed)
- [stedebonnet1688](https://t.me/stedebonnet1688)
- [syriaaa22](https://t.me/syriaaa22)
- [The_infinite_library44](https://t.me/The_infinite_library44)

## Private invite links — 6 (cannot be indexed without joining)

- [invite](https://t.me/+G2jHzF0MfaQ1ZWRi)
- [invite](https://t.me/+lf-PMyQunfs4ZmU1)
- [invite](https://t.me/+Wb1fdBQcQQQ2Mjc1)
- [invite](https://t.me/+GtdlNb08E9FjMDVk)
- [invite](https://t.me/+S6gyO92-YHE-mMPs)
- [invite](https://t.me/+g8Z5W9H1-nA4ZTQy)

## Notes

- The preview has a coverage ceiling: on large/old channels the walk may stop before the first post; `tbi sources` records the oldest post id reached per channel.
- The index holds metadata only — no book files are downloaded or hosted. Files are obtained in Telegram via the post link.
- One non-Telegram site (archive.alsharekh.org, an Arabic magazine archive) is recorded separately in telegram-sources-batch2.md — not for this tool.
- Full source inventory (including the groups above) is in channels.yaml and telegram-sources-batch2.md.
