# Index report — telegram-book-index

**Date:** 2026-11-18T11:08:40.083882+00:00 — **Status:** ok — **Mode:** backfill — **Duration:** 6m 17s
**Config:** `channels.yaml` — **DB:** `index.db`
**Method:** public t.me/s/ previews only, page by page, metadata only (post text, file name/format/size, post link). No API, no login, no account. Book files are never downloaded.
**Note:** Backfill: one block of 3000 posts per channel below the oldest indexed post; a channel is complete when a block reaches post 1 or returns fewer than 3000 posts.

## Summary so far
- **Channels with data: 51 of 51 walkable** — **1140482 posts, 592676 book files** (406380 distinct books)
- **Channels with 0 book files: 8** (drop candidates — see below)
- **Dropped channels: 8** (0 book files in the full first run — history kept in the DB, no longer fetched; see below)
- **Low-density channels: 4** (fewer than 1 book file per 100 posts — kept active, see below)
- **Not yet indexed: 0 channels**
- **Failures this run: 0** (see below; a failed channel keeps its last-good data)
- **Groups indexed from exports: 172** — 0 more groups are commented out in channels.yaml, each needs a Desktop JSON export

## This run
| Channel | New posts | New book files | Scope |
|---|---|---|---|
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 0 | 0 | backfill — complete |
| [alnoorlib](https://t.me/alnoorlib) | 0 | 0 | backfill — complete |
| [daownbook](https://t.me/daownbook) | 0 | 0 | backfill — complete |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 0 | 0 | backfill — complete |
| [kindlbook](https://t.me/kindlbook) | 0 | 0 | backfill — complete |
| [Kindle2](https://t.me/Kindle2) | 0 | 0 | backfill — complete |
| [darkromancenovels](https://t.me/darkromancenovels) | 12 | 0 | backfill — complete |
| [thedevilshours](https://t.me/thedevilshours) | 2 | 0 | backfill — complete |
| [TheEbookStop](https://t.me/TheEbookStop) | 0 | 0 | backfill — complete |
| [ekraly](https://t.me/ekraly) | 964 | 759 | backfill — complete |
| [L_alnader8](https://t.me/L_alnader8) | 1 | 0 | backfill — complete |
| [osratouna1](https://t.me/osratouna1) | 4 | 0 | backfill — complete |
| [rwaiaty4](https://t.me/rwaiaty4) | 0 | 0 | backfill — complete |
| [AAT2024F](https://t.me/AAT2024F) | 0 | 0 | backfill — complete |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 0 | 0 | backfill — complete |
| [eatae](https://t.me/eatae) | 0 | 0 | backfill — complete |
| [altfwok](https://t.me/altfwok) | 12 | 0 | backfill — complete |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 0 | 0 | backfill — complete |
| [alm_elmaref](https://t.me/alm_elmaref) | 0 | 0 | backfill — complete |
| [arabicbooks](https://t.me/arabicbooks) | 0 | 0 | backfill — complete |
| [book_juice](https://t.me/book_juice) | 0 | 0 | backfill — complete |
| [book_lovers_s](https://t.me/book_lovers_s) | 0 | 0 | backfill — complete |
| [books_p](https://t.me/books_p) | 3 | 0 | backfill — complete |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 0 | 0 | backfill — complete |
| [maktabahzahra](https://t.me/maktabahzahra) | 0 | 0 | backfill — complete |
| [n_bhs2](https://t.me/n_bhs2) | 0 | 0 | backfill — complete |
| [nourbook](https://t.me/nourbook) | 0 | 0 | backfill — complete |
| [roayati](https://t.me/roayati) | 2 | 0 | backfill — complete |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 0 | 0 | backfill — complete |
| [Sumarians](https://t.me/Sumarians) | 0 | 0 | backfill — complete |
| [twinkling4](https://t.me/twinkling4) | 1 | 0 | backfill — complete |
| [your_books](https://t.me/your_books) | 0 | 0 | backfill — complete |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 0 | 0 | backfill — complete |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 0 | 0 | backfill — complete |
| [qurany_is_life](https://t.me/qurany_is_life) | 0 | 0 | backfill — complete |
| [jad32](https://t.me/jad32) | 0 | 0 | backfill — complete |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 0 | 0 | backfill — complete |
| [boook1023](https://t.me/boook1023) | 0 | 0 | backfill — complete |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 1 | 0 | backfill — complete |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 0 | 0 | backfill — complete |
| [Ouloalelm](https://t.me/Ouloalelm) | 1 | 0 | backfill — complete |
| [Course_reserve](https://t.me/Course_reserve) | 0 | 0 | backfill — complete |
| [zamerican0english](https://t.me/zamerican0english) | 0 | 0 | backfill — complete |

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
- [ekraly](https://t.me/ekraly) — block: 946 posts, oldest reached 1, complete
  Backfill block: 946 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [L_alnader8](https://t.me/L_alnader8) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [osratouna1](https://t.me/osratouna1) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [rwaiaty4](https://t.me/rwaiaty4) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [AAT2024F](https://t.me/AAT2024F) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [eatae](https://t.me/eatae) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [altfwok](https://t.me/altfwok) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [alm_elmaref](https://t.me/alm_elmaref) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [arabicbooks](https://t.me/arabicbooks) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [book_juice](https://t.me/book_juice) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [book_lovers_s](https://t.me/book_lovers_s) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [books_p](https://t.me/books_p) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [HAYA_NAQRA](https://t.me/HAYA_NAQRA) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [maktabahzahra](https://t.me/maktabahzahra) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [n_bhs2](https://t.me/n_bhs2) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [nourbook](https://t.me/nourbook) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [roayati](https://t.me/roayati) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [sharkelmoreeg](https://t.me/sharkelmoreeg) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Sumarians](https://t.me/Sumarians) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [twinkling4](https://t.me/twinkling4) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [your_books](https://t.me/your_books) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [ahmedsalem81](https://t.me/ahmedsalem81) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [ktbibnalqaim](https://t.me/ktbibnalqaim) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [qurany_is_life](https://t.me/qurany_is_life) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [jad32](https://t.me/jad32) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Merciful111Fate](https://t.me/Merciful111Fate) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [boook1023](https://t.me/boook1023) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Goldenshamelaepub](https://t.me/Goldenshamelaepub) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [kindlearabicbook](https://t.me/kindlearabicbook) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Ouloalelm](https://t.me/Ouloalelm) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [Course_reserve](https://t.me/Course_reserve) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.
- [zamerican0english](https://t.me/zamerican0english) — block: 0 posts, oldest reached 1, complete
  Backfill block: 0 posts; oldest reached 1. Complete — reached the first post or the preview is exhausted.

Complete this run: 43 of 43 channels touched.

## Indexed channels (51)

| Channel | Posts | Book files | Scope |
|---|---|---|---|
| [AAT2024F](https://t.me/AAT2024F) | 11 | 0 | backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3428 | 245 | backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 5489 | 3052 | backfill |
| [alnoorlib](https://t.me/alnoorlib) | 211 | 47 | backfill |
| [altfwok](https://t.me/altfwok) | 17181 | 1002 | backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 1469 | 14 | backfill |
| [arabicbooks](https://t.me/arabicbooks) | 4775 | 694 | backfill |
| [arabicEread](https://t.me/arabicEread) | 3 | 0 | — |
| [book_juice](https://t.me/book_juice) | 4812 | 226 | backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 10824 | 9216 | backfill |
| [Bookkn](https://t.me/Bookkn) | 5 | 0 | — |
| [books_p](https://t.me/books_p) | 8207 | 1201 | backfill |
| [booksguy](https://t.me/booksguy) | 2 | 0 | — |
| [boook1023](https://t.me/boook1023) | 19345 | 4 | backfill |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | backfill |
| [daownbook](https://t.me/daownbook) | 3679 | 1794 | backfill |
| [darkromancenovels](https://t.me/darkromancenovels) | 5155 | 1058 | backfill |
| [eatae](https://t.me/eatae) | 3904 | 386 | backfill |
| [eBookRoom](https://t.me/eBookRoom) | 1670 | 0 | — |
| [Ebookspdfdownload](https://t.me/Ebookspdfdownload) | 2 | 0 | — |
| [ekraly](https://t.me/ekraly) | 55005 | 20029 | backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 30631 | 29093 | backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 4590 | 317 | backfill |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 1185 | 1608 | backfill |
| [jad32](https://t.me/jad32) | 192 | 109 | backfill |
| [kindlbook](https://t.me/kindlbook) | 2983 | 1473 | backfill |
| [Kindle2](https://t.me/Kindle2) | 534 | 19 | backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | backfill |
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 6220 | 3293 | backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | backfill |
| [L_alnader8](https://t.me/L_alnader8) | 24189 | 3490 | backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 8877 | 46 | backfill |
| [Maktademia](https://t.me/Maktademia) | 1 | 0 | — |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 1721 | 1 | backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 21 | 0 | backfill |
| [Motamayezon7](https://t.me/Motamayezon7) | 65 | 0 | — |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | backfill |
| [nourbook](https://t.me/nourbook) | 362 | 0 | backfill |
| [osratouna1](https://t.me/osratouna1) | 5015 | 125 | backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 283 | 85 | backfill |
| [premium_ebooks](https://t.me/premium_ebooks) | 1172 | 0 | — |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | backfill |
| [roayati](https://t.me/roayati) | 560 | 0 | backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 30895 | 11809 | backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | backfill |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | backfill |
| [thedevilshours](https://t.me/thedevilshours) | 2027 | 169 | backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 4812 | 1568 | backfill |
| [twinkling4](https://t.me/twinkling4) | 923 | 287 | backfill |
| [your_books](https://t.me/your_books) | 126 | 0 | backfill |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | backfill |

## Channels with 0 book files — drop candidates (8)

- [AAT2024F](https://t.me/AAT2024F) — 11 posts, 0 book files
- [Merciful111Fate](https://t.me/Merciful111Fate) — 21 posts, 0 book files
- [n_bhs2](https://t.me/n_bhs2) — 2 posts, 0 book files
- [nourbook](https://t.me/nourbook) — 362 posts, 0 book files
- [roayati](https://t.me/roayati) — 560 posts, 0 book files
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

## Low-density channels (4)

Kept active, but they yield fewer than 1 book file per 100 posts — they cost walk time for almost no books. If a channel here stays this sparse, it is the next drop candidate.

- [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) — 1469 posts, 14 book files (0.010 files/post)
- [boook1023](https://t.me/boook1023) — 19345 posts, 4 book files (0.000 files/post)
- [maktabahzahra](https://t.me/maktabahzahra) — 8877 posts, 46 book files (0.005 files/post)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — 1721 posts, 1 book files (0.001 files/post)

## Giants (uncapped walk is impractical)

- [Sumarians](https://t.me/Sumarians) — newest post id 306117 ≈ ~8.5h for a full walk (indexed 52 posts, oldest reached 1)
- [roayati](https://t.me/roayati) — newest post id 289792 ≈ ~8.0h for a full walk (indexed 560 posts, oldest reached 1)
- [ekraly](https://t.me/ekraly) — newest post id 212102 ≈ ~5.9h for a full walk (indexed 55005 posts, oldest reached 1)
- [L_alnader8](https://t.me/L_alnader8) — newest post id 80359 ≈ ~2.2h for a full walk (indexed 24189 posts, oldest reached 1)
- [rwaiaty4](https://t.me/rwaiaty4) — newest post id 54364 ≈ ~1.5h for a full walk (indexed 30895 posts, oldest reached 1)

## What failed so far

Nothing failed on this run.

## Not yet indexed — remaining 0 channels

None — every channel in the config has been indexed.

## Not indexable live — groups (need a Desktop JSON export each)

Reason: public groups have no t.me/s/ preview, so live scraping is impossible. Each group needs a Telegram Desktop 'Export chat history' as JSON (result.json), then its entry is uncommented in channels.yaml. No export has been produced yet for most groups.

- aa2tyuq — 5942 posts, 5561 book files (ok)
- abjjad_free — 2589 posts, 1294 book files (ok)
- abntaymia3 — 2939 posts, 596 book files (ok)
- abo_abdu — 9075 posts, 3975 book files (ok)
- adventurers5 — 220 posts, 144 book files (ok)
- Ahlahadota — 1386 posts, 9 book files (ok)
- ahn1972 — 9000 posts, 4717 book files (ok)
- ahn2323 — 9020 posts, 4742 book files (ok)
- al-suhuf-wal-majallat-al-ajnabiya — 3000 posts, 2807 book files (ok)
- alanbyawardmsr — 8929 posts, 3632 book files (ok)
- All_kinds_Books_Lib — 12657 posts, 9185 book files (ok)
- almaktbhh — 9000 posts, 4134 book files (ok)
- almeshkat2023 — 9036 posts, 4997 book files (ok)
- almoghmiroonal5msa — 641 posts, 241 book files (ok)
- Almootnbe100 — 9013 posts, 7083 book files (ok)
- Arabic_PDF — 560 posts, 260 book files (ok)
- Arabickindle1 — 9000 posts, 7961 book files (ok)
- ArabicMagazine — 475 posts, 22 book files (ok)
- arabJournalism — 9587 posts, 8161 book files (ok)
- art_of_book — 1120 posts, 452 book files (ok)
- ArwaCoffeeBook — 5554 posts, 374 book files (ok)
- asseralkotob — 1169 posts, 768 book files (ok)
- audiobooks_kid — 126 posts, 0 book files (ok)
- BabyEnglishBooks — 3438 posts, 3059 book files (ok)
- baz_book — 9065 posts, 4861 book files (ok)
- book100100 — 17 posts, 8 book files (ok)
- book350 — 4409 posts, 2371 book files (ok)
- book4kid — 801 posts, 528 book files (ok)
- Book_cr2 — 9143 posts, 3951 book files (ok)
- BOOK_HOUSE_INTERNATIONAL — 2495 posts, 1023 book files (ok)
- bookcheldren — 9010 posts, 6474 book files (ok)
- BOOKCLUB_AR — 278 posts, 153 book files (ok)
- bookclubarabic — 341 posts, 257 book files (ok)
- Bookes2023 — 6431 posts, 3772 book files (ok)
- bookforbooks — 1136 posts, 148 book files (ok)
- BoOkJuiCe — 3627 posts, 1625 book files (ok)
- bookjunkieb — 4397 posts, 3024 book files (ok)
- bookpdfepub — 3690 posts, 712 book files (ok)
- books2023 — 9699 posts, 9551 book files (ok)
- booksforarabs — 5404 posts, 3277 book files (ok)
- bookspsychology101 — 2619 posts, 1535 book files (ok)
- bookstoragebox — 3000 posts, 645 book files (ok)
- BROKAREEMANDME — 9148 posts, 3087 book files (ok)
- cambridge_library — 261 posts, 78 book files (ok)
- Comics_gate — 8677 posts, 8076 book files (ok)
- comics_link — 9002 posts, 4495 book files (ok)
- CoolBooks — 2763 posts, 1467 book files (ok)
- cozmoBooks — 9004 posts, 7815 book files (ok)
- dar-maana — 143 posts, 70 book files (ok)
- ddfkindle — 1376 posts, 834 book files (ok)
- debsibooks — 5221 posts, 1516 book files (ok)
- donaldduckcomics — 5521 posts, 4657 book files (ok)
- DrKhaledFahmy — 394 posts, 169 book files (ok)
- Drnonaphrmacy — 7517 posts, 383 book files (ok)
- dvjhtj — 2787 posts, 0 book files (ok)
- e_books_eng — 219 posts, 107 book files (ok)
- easymath121 — 9026 posts, 223 book files (ok)
- EBook_Library — 12064 posts, 9362 book files (ok)
- ebookstoread — 8178 posts, 3497 book files (ok)
- ekraly3 — 9134 posts, 3693 book files (ok)
- englishbooks99 — 1231 posts, 915 book files (ok)
- englishcafe_1 — 2445 posts, 688 book files (ok)
- Free_IslamicBooks — 2453 posts, 1443 book files (ok)
- freebooksf — 9001 posts, 5072 book files (ok)
- FreeEbookDownloadEnglish — 5547 posts, 5457 book files (ok)
- fun_to_read — 9056 posts, 8556 book files (ok)
- G5_Y5 — 9002 posts, 8713 book files (ok)
- GoldenshamelaGroup — 9056 posts, 239 book files (ok)
- HadiAriyanLibrary — 4462 posts, 1797 book files (ok)
- HindawiFoundationBooks — 534 posts, 266 book files (ok)
- HoSo0oN — 474 posts, 335 book files (ok)
- isalmickindl — 362 posts, 279 book files (ok)
- IslamicLibrary1 — 9004 posts, 5832 book files (ok)
- islamicMoral — 4318 posts, 987 book files (ok)
- jame3_masahif — 219 posts, 105 book files (ok)
- jami-al-kutub-al-musawwara — 3000 posts, 1408 book files (ok)
- jazz223k — 9041 posts, 5676 book files (ok)
- julietbookstoregroup — 9107 posts, 3149 book files (ok)
- julietyoya — 9057 posts, 3992 book files (ok)
- K3tabi — 8 posts, 0 book files (ok)
- K3tabiCo — 725 posts, 465 book files (ok)
- katabataa — 9000 posts, 3496 book files (ok)
- kfxarabic — 11744 posts, 11697 book files (ok)
- khatabg — 9010 posts, 5515 book files (ok)
- kidsbookden — 3616 posts, 2895 book files (ok)
- kindel4 — 12000 posts, 7498 book files (ok)
- kindle4kurd — 12197 posts, 7255 book files (ok)
- KindleArabicLibrary — 6521 posts, 6512 book files (ok)
- KindleKotob — 12002 posts, 10476 book files (ok)
- kj7_oi — 3949 posts, 1798 book files (ok)
- KOTOB_ISLAMIC — 9069 posts, 4926 book files (ok)
- KotobEslamiah — 9079 posts, 3847 book files (ok)
- kotobkhana — 20 posts, 9 book files (ok)
- KotobkhanaPDF — 169 posts, 82 book files (ok)
- kotokhatab — 9012 posts, 6416 book files (ok)
- kottobgededa1977 — 2499 posts, 1949 book files (ok)
- ktbmB_othaimen — 1451 posts, 514 book files (ok)
- ktbmfid — 9003 posts, 5697 book files (ok)
- L_alnader1 — 9005 posts, 6945 book files (ok)
- L_alnader14 — 9013 posts, 6976 book files (ok)
- l_alnader2 — 9036 posts, 6242 book files (ok)
- langcours — 6008 posts, 2283 book files (ok)
- lastStopbooks — 6381 posts, 6337 book files (ok)
- Legacy_1945 — 5288 posts, 3290 book files (ok)
- lenaqra — 5115 posts, 2471 book files (ok)
- lenaqra3 — 8319 posts, 2823 book files (ok)
- llllTTTWW — 9008 posts, 2062 book files (ok)
- lovekotob — 9000 posts, 8294 book files (ok)
- M3RFAHALKOTOB — 9112 posts, 5615 book files (ok)
- magazineguy — 80 posts, 77 book files (ok)
- Mahmoud_Salem_5 — 184 posts, 183 book files (ok)
- MaktabaBook — 7322 posts, 3916 book files (ok)
- maktbahnet — 9000 posts, 17 book files (ok)
- maktbapdf — 9276 posts, 2 book files (ok)
- maktph — 9002 posts, 6757 book files (ok)
- megalatnawader — 917 posts, 21 book files (ok)
- mergebooks — 4944 posts, 1694 book files (ok)
- Mohanime — 525 posts, 0 book files (ok)
- Motamayz00n — 193 posts, 128 book files (ok)
- muscatnonfiction — 8502 posts, 4214 book files (ok)
- mybook22 — 9098 posts, 8902 book files (ok)
- MyEnglishChannel — 5046 posts, 774 book files (ok)
- NewBooksAndEditions — 6220 posts, 3212 book files (ok)
- ni3mehalzoubi — 2219 posts, 1219 book files (ok)
- noorlibrarykids — 9003 posts, 7912 book files (ok)
- novels2n — 9017 posts, 7520 book files (ok)
- Numidia_Library — 4054 posts, 1770 book files (ok)
- OnePageAway — 9000 posts, 1612 book files (ok)
- oxford_bookworms_lm — 1868 posts, 326 book files (ok)
- Oxford_Bookwormss — 576 posts, 104 book files (ok)
- OxfordBookwormers — 1773 posts, 191 book files (ok)
- OxfordBookwormsDominoes1 — 1631 posts, 205 book files (ok)
- OxfordReadingTree — 4496 posts, 908 book files (ok)
- palkotob — 9000 posts, 5103 book files (ok)
- pdf_novels — 9000 posts, 4777 book files (ok)
- pdfiat — 203 posts, 106 book files (ok)
- pdfkotab19 — 905 posts, 874 book files (ok)
- PDFnew — 9052 posts, 4913 book files (ok)
- plussheets — 1650 posts, 901 book files (ok)
- pokidz — 2977 posts, 470 book files (ok)
- qra_at — 8878 posts, 3376 book files (ok)
- quwaa — 2791 posts, 1319 book files (ok)
- read00 — 9000 posts, 8197 book files (ok)
- READ4OR — 306 posts, 133 book files (ok)
- Rff404 — 74 posts, 33 book files (ok)
- Sa7eralkutub — 4137 posts, 704 book files (ok)
- safi_book — 9065 posts, 4484 book files (ok)
- samaheltaweelkidsstories — 268 posts, 208 book files (ok)
- SARIQriwayat — 63 posts, 30 book files (ok)
- sciencecamp1 — 3427 posts, 1350 book files (ok)
- scincematerialsMH — 787 posts, 524 book files (ok)
- shamarly — 1103 posts, 375 book files (ok)
- shamela4kindle — 6000 posts, 4702 book files (ok)
- shamela_epub — 6000 posts, 5996 book files (ok)
- shamela_kindle — 6000 posts, 3123 book files (ok)
- ShamelaMakhtota — 31 posts, 8 book files (ok)
- soramnqraa — 3444 posts, 2962 book files (ok)
- stories_kids — 149 posts, 31 book files (ok)
- storybooksforkids — 634 posts, 395 book files (ok)
- storybookspdf — 378 posts, 157 book files (ok)
- tahmilkutubwarosaililmiyah — 4861 posts, 4439 book files (ok)
- tea_sugar — 9048 posts, 5005 book files (ok)
- the_romance_hub — 2188 posts, 1985 book files (ok)
- Tleeq — 195 posts, 13 book files (ok)
- To_The_Book — 9005 posts, 5406 book files (ok)
- trunkietrunk — 9119 posts, 8781 book files (ok)
- wadistreambooks — 419 posts, 218 book files (ok)
- wessam_pdf — 9000 posts, 8616 book files (ok)
- xepub — 209 posts, 85 book files (ok)
- yasmeenbook — 1046 posts, 633 book files (ok)
- ZAmericanEnglishCourse — 224 posts, 84 book files (ok)
- zamericangroup — 6000 posts, 84 book files (ok)

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
