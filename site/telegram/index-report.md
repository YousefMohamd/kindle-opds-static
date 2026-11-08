# Index report — telegram-book-index

**Date:** 2026-11-08T22:39:29.860583+00:00 — **Status:** partial — **Mode:** api-backfill — **Duration:** 2h 4m
**Config:** `channels.yaml` — **DB:** `index.db`
**Method:** public t.me/s/ previews only, page by page, metadata only (post text, file name/format/size, post link). No API, no login, no account. Book files are never downloaded.
**Note:** STOPPED by a Telegram flood-wait on username resolution: @isalmickindl needs a 67472 second wait (until 2026-11-09T17:24:01.859447+00:00). No further sources were attempted — re-run after the wait expires. The entity cache means the next run resolves each handle only once.

## Summary so far
- **Channels with data: 51 of 51 walkable** — **566089 posts, 251667 book files** (197304 distinct books)
- **Channels with 0 book files: 8** (drop candidates — see below)
- **Dropped channels: 8** (0 book files in the full first run — history kept in the DB, no longer fetched; see below)
- **Low-density channels: 4** (fewer than 1 book file per 100 posts — kept active, see below)
- **Not yet indexed: 0 channels**
- **Failures this run: 1** (see below; a failed channel keeps its last-good data)
- **Groups indexed from exports: 168** — 0 more groups are commented out in channels.yaml, each needs a Desktop JSON export

## This run
| Channel | New posts | New book files | Scope |
|---|---|---|---|
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 0 | 0 | api-backfill |
| [alnoorlib](https://t.me/alnoorlib) | 0 | 0 | api-backfill |
| [daownbook](https://t.me/daownbook) | 0 | 0 | api-backfill |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 0 | 0 | api-backfill |
| [kindlbook](https://t.me/kindlbook) | 0 | 0 | api-backfill |
| [Kindle2](https://t.me/Kindle2) | 0 | 0 | api-backfill |
| [darkromancenovels](https://t.me/darkromancenovels) | 8 | 3 | api-backfill |
| [thedevilshours](https://t.me/thedevilshours) | 3 | 0 | api-backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 0 | 0 | api-backfill |
| [ekraly](https://t.me/ekraly) | 3001 | 789 | api-backfill |
| [L_alnader8](https://t.me/L_alnader8) | 3001 | 891 | api-backfill |
| [osratouna1](https://t.me/osratouna1) | 4 | 0 | api-backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 3000 | 490 | api-backfill |
| [AAT2024F](https://t.me/AAT2024F) | 0 | 0 | api-backfill |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 0 | 0 | api-backfill |
| [eatae](https://t.me/eatae) | 0 | 0 | api-backfill |
| [altfwok](https://t.me/altfwok) | 0 | 0 | api-backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 0 | 0 | api-backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 0 | 0 | api-backfill |
| [arabicbooks](https://t.me/arabicbooks) | 0 | 0 | api-backfill |
| [book_juice](https://t.me/book_juice) | 0 | 0 | api-backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 0 | 0 | api-backfill |
| [books_p](https://t.me/books_p) | 3 | 0 | api-backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 0 | 0 | api-backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 0 | 0 | api-backfill |
| [n_bhs2](https://t.me/n_bhs2) | 0 | 0 | api-backfill |
| [nourbook](https://t.me/nourbook) | 0 | 0 | api-backfill |
| [roayati](https://t.me/roayati) | 1 | 0 | api-backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 0 | 0 | api-backfill |
| [Sumarians](https://t.me/Sumarians) | 0 | 0 | api-backfill |
| [twinkling4](https://t.me/twinkling4) | 0 | 0 | api-backfill |
| [your_books](https://t.me/your_books) | 0 | 0 | api-backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 0 | 0 | api-backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 0 | 0 | api-backfill |
| [qurany_is_life](https://t.me/qurany_is_life) | 0 | 0 | api-backfill |
| [jad32](https://t.me/jad32) | 0 | 0 | api-backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 0 | 0 | api-backfill |
| [boook1023](https://t.me/boook1023) | 3000 | 0 | api-backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 3001 | 3000 | api-backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 0 | 0 | api-backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 0 | 0 | api-backfill |
| [Course_reserve](https://t.me/Course_reserve) | 0 | 0 | api-backfill |
| [zamerican0english](https://t.me/zamerican0english) | 0 | 0 | api-backfill |
| All_kinds_Books_Lib (group) | 3004 | 2578 | export |
| Arabickindle1 (group) | 3000 | 2718 | export |
| BOOKCLUB_AR (group) | 278 | 153 | export |
| bookclubarabic (group) | 341 | 257 | export |
| booksforarabs (group) | 3000 | 1896 | export |
| ddfkindle (group) | 1376 | 834 | export |
| EBook_Library (group) | 3020 | 2208 | export |
| jazz223k (group) | 3000 | 1377 | export |
| kfxarabic (group) | 3000 | 2985 | export |
| kindel4 (group) | 3000 | 1826 | export |
| kindle4kurd (group) | 3000 | 1886 | export |
| KindleArabicLibrary (group) | 3000 | 2994 | export |
| KindleKotob (group) | 3000 | 2428 | export |
| kotobkhana (group) | 0 | 0 | export |
| pdfiat (group) | 203 | 106 | export |
| xepub (group) | 204 | 84 | export |
| BOOK_HOUSE_INTERNATIONAL (group) | 2495 | 1023 | export |
| bookjunkieb (group) | 3000 | 2185 | export |
| bookpdfepub (group) | 807 | 152 | export |
| bookspsychology101 (group) | 2551 | 1512 | export |
| CoolBooks (group) | 2763 | 1467 | export |
| e_books_eng (group) | 219 | 107 | export |
| ebookstoread (group) | 3000 | 1254 | export |
| englishbooks99 (group) | 1231 | 915 | export |
| FreeEbookDownloadEnglish (group) | 3000 | 2975 | export |
| Legacy_1945 (group) | 3000 | 1792 | export |
| muscatnonfiction (group) | 3000 | 1433 | export |
| OnePageAway (group) | 3000 | 1 | export |
| oxford_bookworms_lm (group) | 1868 | 326 | export |
| Oxford_Bookwormss (group) | 576 | 104 | export |
| OxfordBookwormers (group) | 1773 | 191 | export |
| OxfordBookwormsDominoes1 (group) | 1631 | 205 | export |
| OxfordReadingTree (group) | 3000 | 512 | export |
| storybookspdf (group) | 378 | 157 | export |
| the_romance_hub (group) | 2166 | 1973 | export |
| trunkietrunk (group) | 3000 | 2928 | export |
| adventurers5 (group) | 220 | 144 | export |
| Ahlahadota (group) | 1385 | 9 | export |
| almoghmiroonal5msa (group) | 641 | 241 | export |
| Arabic_PDF (group) | 560 | 260 | export |
| bookcheldren (group) | 3000 | 1803 | export |
| Mahmoud_Salem_5 (group) | 184 | 183 | export |
| maktph (group) | 3000 | 2239 | export |
| noorlibrarykids (group) | 3000 | 2705 | export |
| pokidz (group) | 2946 | 470 | export |
| samaheltaweelkidsstories (group) | 268 | 208 | export |
| Comics_gate (group) | 3000 | 2635 | export |
| comics_link (group) | 3000 | 1564 | export |
| donaldduckcomics (group) | 3000 | 2347 | export |
| Mohanime (group) | 525 | 0 | export |
| BabyEnglishBooks (group) | 3000 | 2669 | export |
| book4kid (group) | 801 | 528 | export |
| stories_kids (group) | 149 | 31 | export |
| storybooksforkids (group) | 634 | 395 | export |
| audiobooks_kid (group) | 126 | 0 | export |
| easymath121 (group) | 3000 | 6 | export |
| G5_Y5 (group) | 3000 | 2879 | export |
| kidsbookden (group) | 3000 | 2301 | export |
| plussheets (group) | 1650 | 901 | export |
| sciencecamp1 (group) | 3000 | 1305 | export |
| scincematerialsMH (group) | 787 | 524 | export |
| ArabicMagazine (group) | 475 | 22 | export |
| arabJournalism (group) | 3000 | 2554 | export |
| magazineguy (group) | 80 | 77 | export |
| megalatnawader (group) | 917 | 21 | export |
| aa2tyuq (group) | 3000 | 2881 | export |
| abo_abdu (group) | 3000 | 1266 | export |
| ahn1972 (group) | 3000 | 1547 | export |
| ahn2323 (group) | 3000 | 1534 | export |
| alanbyawardmsr (group) | 3000 | 1002 | export |
| almaktbhh (group) | 3000 | 1423 | export |
| Almootnbe100 (group) | 3000 | 2273 | export |
| art_of_book (group) | 1120 | 452 | export |
| ArwaCoffeeBook (group) | 3000 | 102 | export |
| asseralkotob (group) | 1143 | 750 | export |
| book100100 (group) | 17 | 8 | export |
| book350 (group) | 3000 | 1668 | export |
| Book_cr2 (group) | 3000 | 1388 | export |
| Bookes2023 (group) | 3000 | 1551 | export |
| bookforbooks (group) | 1136 | 148 | export |
| BoOkJuiCe (group) | 3000 | 1261 | export |
| books2023 (group) | 3000 | 2966 | export |
| BROKAREEMANDME (group) | 3000 | 1261 | export |
| cozmoBooks (group) | 3000 | 2169 | export |
| debsibooks (group) | 3000 | 885 | export |
| DrKhaledFahmy (group) | 394 | 169 | export |
| ekraly3 (group) | 3000 | 901 | export |
| freebooksf (group) | 3000 | 1719 | export |
| fun_to_read (group) | 3000 | 2776 | export |
| HadiAriyanLibrary (group) | 3000 | 1270 | export |
| HindawiFoundationBooks (group) | 534 | 266 | export |
| HoSo0oN (group) | 466 | 332 | export |
| julietyoya (group) | 3000 | 1242 | export |
| katabataa (group) | 3000 | 1171 | export |
| khatabg (group) | 3000 | 1696 | export |
| KotobkhanaPDF (group) | 169 | 82 | export |
| kotokhatab (group) | 3000 | 1921 | export |
| kottobgededa1977 (group) | 2499 | 1949 | export |
| L_alnader1 (group) | 3000 | 2124 | export |
| L_alnader14 (group) | 3000 | 2376 | export |
| l_alnader2 (group) | 3000 | 2244 | export |
| lastStopbooks (group) | 3000 | 2973 | export |
| lenaqra (group) | 3000 | 1416 | export |
| lenaqra3 (group) | 3000 | 910 | export |
| llllTTTWW (group) | 3000 | 538 | export |
| lovekotob (group) | 3000 | 2745 | export |
| M3RFAHALKOTOB (group) | 3000 | 1668 | export |
| MaktabaBook (group) | 3000 | 1695 | export |
| maktbahnet (group) | 3000 | 17 | export |
| maktbapdf (group) | 3000 | 2 | export |
| mybook22 (group) | 3000 | 2949 | export |
| ni3mehalzoubi (group) | 2217 | 1217 | export |
| novels2n (group) | 3000 | 2251 | export |
| Numidia_Library (group) | 3000 | 1373 | export |
| pdf_novels (group) | 3000 | 1182 | export |
| pdfkotab19 (group) | 905 | 874 | export |
| read00 (group) | 3000 | 2985 | export |
| Sa7eralkutub (group) | 3000 | 665 | export |
| soramnqraa (group) | 3000 | 2663 | export |
| tea_sugar (group) | 3000 | 1906 | export |
| To_The_Book (group) | 3000 | 1752 | export |
| wadistreambooks (group) | 419 | 218 | export |
| wessam_pdf (group) | 3000 | 2776 | export |
| yasmeenbook (group) | 1046 | 633 | export |
| abntaymia3 (group) | 2931 | 594 | export |
| almeshkat2023 (group) | 3000 | 1443 | export |
| baz_book (group) | 3000 | 1557 | export |
| Drnonaphrmacy (group) | 3000 | 9 | export |
| dvjhtj (group) | 2787 | 0 | export |
| Free_IslamicBooks (group) | 2451 | 1442 | export |
| IslamicLibrary1 (group) | 3000 | 2021 | export |
| islamicMoral (group) | 3000 | 673 | export |
| kj7_oi (group) | 3000 | 1331 | export |
| KOTOB_ISLAMIC (group) | 3000 | 1559 | export |
| KotobEslamiah (group) | 3000 | 1520 | export |
| ktbmB_othaimen (group) | 1451 | 514 | export |
| ktbmfid (group) | 3000 | 1543 | export |
| mergebooks (group) | 3000 | 1118 | export |
| NewBooksAndEditions (group) | 3000 | 1336 | export |
| palkotob (group) | 3000 | 1675 | export |
| PDFnew (group) | 3000 | 1582 | export |
| qra_at (group) | 3000 | 1181 | export |
| quwaa (group) | 2790 | 1319 | export |
| safi_book (group) | 3000 | 1446 | export |
| tahmilkutubwarosaililmiyah (group) | 3000 | 2686 | export |
| jame3_masahif (group) | 219 | 105 | export |
| shamarly (group) | 1100 | 375 | export |
| abjjad_free (group) | 2589 | 1294 | export |
| julietbookstoregroup (group) | 3000 | 966 | export |
| K3tabi (group) | 8 | 0 | export |
| K3tabiCo (group) | 724 | 465 | export |
| Motamayz00n (group) | 193 | 128 | export |
| READ4OR (group) | 202 | 93 | export |
| Rff404 (group) | 14 | 4 | export |
| SARIQriwayat (group) | 41 | 19 | export |
| GoldenshamelaGroup (group) | 3000 | 29 | export |
| isalmickindl (group) | 0 | 0 | export |

## Indexed channels (51)

| Channel | Posts | Book files | Scope |
|---|---|---|---|
| [AAT2024F](https://t.me/AAT2024F) | 11 | 0 | api-backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3422 | 244 | api-backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 5489 | 3052 | api-backfill |
| [alnoorlib](https://t.me/alnoorlib) | 211 | 47 | api-backfill |
| [altfwok](https://t.me/altfwok) | 17056 | 1000 | api-backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 1469 | 14 | api-backfill |
| [arabicbooks](https://t.me/arabicbooks) | 4775 | 694 | api-backfill |
| [arabicEread](https://t.me/arabicEread) | 3 | 0 | — |
| [book_juice](https://t.me/book_juice) | 4808 | 226 | api-backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 10824 | 9216 | api-backfill |
| [Bookkn](https://t.me/Bookkn) | 5 | 0 | — |
| [books_p](https://t.me/books_p) | 8157 | 1195 | api-backfill |
| [booksguy](https://t.me/booksguy) | 2 | 0 | — |
| [boook1023](https://t.me/boook1023) | 18000 | 4 | api-backfill |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | api-backfill |
| [daownbook](https://t.me/daownbook) | 3679 | 1794 | api-backfill |
| [darkromancenovels](https://t.me/darkromancenovels) | 5087 | 1057 | api-backfill |
| [eatae](https://t.me/eatae) | 3904 | 386 | api-backfill |
| [eBookRoom](https://t.me/eBookRoom) | 1670 | 0 | — |
| [Ebookspdfdownload](https://t.me/Ebookspdfdownload) | 2 | 0 | — |
| [ekraly](https://t.me/ekraly) | 21012 | 1053 | api-backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 18001 | 16469 | api-backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 4583 | 317 | api-backfill |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 1185 | 1608 | api-backfill |
| [jad32](https://t.me/jad32) | 192 | 109 | api-backfill |
| [kindlbook](https://t.me/kindlbook) | 2983 | 1473 | api-backfill |
| [Kindle2](https://t.me/Kindle2) | 534 | 19 | api-backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | api-backfill |
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 6220 | 3293 | api-backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | api-backfill |
| [L_alnader8](https://t.me/L_alnader8) | 21004 | 2623 | api-backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 8877 | 46 | api-backfill |
| [Maktademia](https://t.me/Maktademia) | 1 | 0 | — |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 1721 | 1 | api-backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 20 | 0 | api-backfill |
| [Motamayezon7](https://t.me/Motamayezon7) | 65 | 0 | — |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | api-backfill |
| [nourbook](https://t.me/nourbook) | 362 | 0 | api-backfill |
| [osratouna1](https://t.me/osratouna1) | 4965 | 125 | api-backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 278 | 85 | api-backfill |
| [premium_ebooks](https://t.me/premium_ebooks) | 1172 | 0 | — |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | api-backfill |
| [roayati](https://t.me/roayati) | 531 | 0 | api-backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 21002 | 9509 | api-backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | api-backfill |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | api-backfill |
| [thedevilshours](https://t.me/thedevilshours) | 2013 | 169 | api-backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 4812 | 1568 | api-backfill |
| [twinkling4](https://t.me/twinkling4) | 921 | 287 | api-backfill |
| [your_books](https://t.me/your_books) | 126 | 0 | api-backfill |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | api-backfill |

## Channels with 0 book files — drop candidates (8)

- [AAT2024F](https://t.me/AAT2024F) — 11 posts, 0 book files
- [Merciful111Fate](https://t.me/Merciful111Fate) — 20 posts, 0 book files
- [n_bhs2](https://t.me/n_bhs2) — 2 posts, 0 book files
- [nourbook](https://t.me/nourbook) — 362 posts, 0 book files
- [roayati](https://t.me/roayati) — 531 posts, 0 book files
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
- [boook1023](https://t.me/boook1023) — 18000 posts, 4 book files (0.000 files/post)
- [maktabahzahra](https://t.me/maktabahzahra) — 8877 posts, 46 book files (0.005 files/post)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — 1721 posts, 1 book files (0.001 files/post)

## Giants (uncapped walk is impractical)

- [Sumarians](https://t.me/Sumarians) — newest post id 306117 ≈ ~8.5h for a full walk (indexed 52 posts, oldest reached 1)
- [roayati](https://t.me/roayati) — newest post id 289172 ≈ ~8.0h for a full walk (indexed 531 posts, oldest reached 1)
- [ekraly](https://t.me/ekraly) — newest post id 211530 ≈ ~5.9h for a full walk (indexed 21012 posts, oldest reached 100784)
- [L_alnader8](https://t.me/L_alnader8) — newest post id 80309 ≈ ~2.2h for a full walk (indexed 21004 posts, oldest reached 5698)
- [rwaiaty4](https://t.me/rwaiaty4) — newest post id 54364 ≈ ~1.5h for a full walk (indexed 21002 posts, oldest reached 15683)

## What failed so far

- isalmickindl (group) — @isalmickindl: a wait of 67472 seconds is required (ResolveUsernameRequest)
- [MyEnglishChannel](https://t.me/MyEnglishChannel) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ShamelaMakhtota](https://t.me/ShamelaMakhtota) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Tleeq](https://t.me/Tleeq) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ZAmericanEnglishCourse](https://t.me/ZAmericanEnglishCourse) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [cambridge_library](https://t.me/cambridge_library) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [englishcafe_1](https://t.me/englishcafe_1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [langcours](https://t.me/langcours) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela4kindle](https://t.me/shamela4kindle) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela_epub](https://t.me/shamela_epub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela_kindle](https://t.me/shamela_kindle) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [zamericangroup](https://t.me/zamericangroup) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)

## Not yet indexed — remaining 0 channels

None — every channel in the config has been indexed.

## Not indexable live — groups (need a Desktop JSON export each)

Reason: public groups have no t.me/s/ preview, so live scraping is impossible. Each group needs a Telegram Desktop 'Export chat history' as JSON (result.json), then its entry is uncommented in channels.yaml. No export has been produced yet for most groups.

- aa2tyuq — 3000 posts, 2881 book files (ok)
- abjjad_free — 2589 posts, 1294 book files (ok)
- abntaymia3 — 2931 posts, 594 book files (ok)
- abo_abdu — 3000 posts, 1266 book files (ok)
- adventurers5 — 220 posts, 144 book files (ok)
- Ahlahadota — 1385 posts, 9 book files (ok)
- ahn1972 — 3000 posts, 1547 book files (ok)
- ahn2323 — 3000 posts, 1534 book files (ok)
- alanbyawardmsr — 3000 posts, 1002 book files (ok)
- All_kinds_Books_Lib — 6004 posts, 4751 book files (ok)
- almaktbhh — 3000 posts, 1423 book files (ok)
- almeshkat2023 — 3000 posts, 1443 book files (ok)
- almoghmiroonal5msa — 641 posts, 241 book files (ok)
- Almootnbe100 — 3000 posts, 2273 book files (ok)
- Arabic_PDF — 560 posts, 260 book files (ok)
- Arabickindle1 — 3000 posts, 2718 book files (ok)
- ArabicMagazine — 475 posts, 22 book files (ok)
- arabJournalism — 3000 posts, 2554 book files (ok)
- art_of_book — 1120 posts, 452 book files (ok)
- ArwaCoffeeBook — 3000 posts, 102 book files (ok)
- asseralkotob — 1143 posts, 750 book files (ok)
- audiobooks_kid — 126 posts, 0 book files (ok)
- BabyEnglishBooks — 3000 posts, 2669 book files (ok)
- baz_book — 3000 posts, 1557 book files (ok)
- book100100 — 17 posts, 8 book files (ok)
- book350 — 3000 posts, 1668 book files (ok)
- book4kid — 801 posts, 528 book files (ok)
- Book_cr2 — 3000 posts, 1388 book files (ok)
- BOOK_HOUSE_INTERNATIONAL — 2495 posts, 1023 book files (ok)
- bookcheldren — 3000 posts, 1803 book files (ok)
- BOOKCLUB_AR — 278 posts, 153 book files (ok)
- bookclubarabic — 341 posts, 257 book files (ok)
- Bookes2023 — 3000 posts, 1551 book files (ok)
- bookforbooks — 1136 posts, 148 book files (ok)
- BoOkJuiCe — 3000 posts, 1261 book files (ok)
- bookjunkieb — 3000 posts, 2185 book files (ok)
- bookpdfepub — 807 posts, 152 book files (ok)
- books2023 — 3000 posts, 2966 book files (ok)
- booksforarabs — 3000 posts, 1896 book files (ok)
- bookspsychology101 — 2551 posts, 1512 book files (ok)
- BROKAREEMANDME — 3000 posts, 1261 book files (ok)
- cambridge_library — 0 posts, 0 book files (error)
- Comics_gate — 3000 posts, 2635 book files (ok)
- comics_link — 3000 posts, 1564 book files (ok)
- CoolBooks — 2763 posts, 1467 book files (ok)
- cozmoBooks — 3000 posts, 2169 book files (ok)
- ddfkindle — 1376 posts, 834 book files (ok)
- debsibooks — 3000 posts, 885 book files (ok)
- donaldduckcomics — 3000 posts, 2347 book files (ok)
- DrKhaledFahmy — 394 posts, 169 book files (ok)
- Drnonaphrmacy — 3000 posts, 9 book files (ok)
- dvjhtj — 2787 posts, 0 book files (ok)
- e_books_eng — 219 posts, 107 book files (ok)
- easymath121 — 3000 posts, 6 book files (ok)
- EBook_Library — 6020 posts, 4208 book files (ok)
- ebookstoread — 3000 posts, 1254 book files (ok)
- ekraly3 — 3000 posts, 901 book files (ok)
- englishbooks99 — 1231 posts, 915 book files (ok)
- englishcafe_1 — 0 posts, 0 book files (error)
- Free_IslamicBooks — 2451 posts, 1442 book files (ok)
- freebooksf — 3000 posts, 1719 book files (ok)
- FreeEbookDownloadEnglish — 3000 posts, 2975 book files (ok)
- fun_to_read — 3000 posts, 2776 book files (ok)
- G5_Y5 — 3000 posts, 2879 book files (ok)
- GoldenshamelaGroup — 3000 posts, 29 book files (ok)
- HadiAriyanLibrary — 3000 posts, 1270 book files (ok)
- HindawiFoundationBooks — 534 posts, 266 book files (ok)
- HoSo0oN — 466 posts, 332 book files (ok)
- isalmickindl — 0 posts, 0 book files (error)
- IslamicLibrary1 — 3000 posts, 2021 book files (ok)
- islamicMoral — 3000 posts, 673 book files (ok)
- jame3_masahif — 219 posts, 105 book files (ok)
- jazz223k — 3000 posts, 1377 book files (ok)
- julietbookstoregroup — 3000 posts, 966 book files (ok)
- julietyoya — 3000 posts, 1242 book files (ok)
- K3tabi — 8 posts, 0 book files (ok)
- K3tabiCo — 724 posts, 465 book files (ok)
- katabataa — 3000 posts, 1171 book files (ok)
- kfxarabic — 3000 posts, 2985 book files (ok)
- khatabg — 3000 posts, 1696 book files (ok)
- kidsbookden — 3000 posts, 2301 book files (ok)
- kindel4 — 3000 posts, 1826 book files (ok)
- kindle4kurd — 3000 posts, 1886 book files (ok)
- KindleArabicLibrary — 3000 posts, 2994 book files (ok)
- KindleKotob — 3000 posts, 2428 book files (ok)
- kj7_oi — 3000 posts, 1331 book files (ok)
- KOTOB_ISLAMIC — 3000 posts, 1559 book files (ok)
- KotobEslamiah — 3000 posts, 1520 book files (ok)
- kotobkhana — 0 posts, 0 book files (ok)
- KotobkhanaPDF — 169 posts, 82 book files (ok)
- kotokhatab — 3000 posts, 1921 book files (ok)
- kottobgededa1977 — 2499 posts, 1949 book files (ok)
- ktbmB_othaimen — 1451 posts, 514 book files (ok)
- ktbmfid — 3000 posts, 1543 book files (ok)
- L_alnader1 — 3000 posts, 2124 book files (ok)
- L_alnader14 — 3000 posts, 2376 book files (ok)
- l_alnader2 — 3000 posts, 2244 book files (ok)
- langcours — 0 posts, 0 book files (error)
- lastStopbooks — 3000 posts, 2973 book files (ok)
- Legacy_1945 — 3000 posts, 1792 book files (ok)
- lenaqra — 3000 posts, 1416 book files (ok)
- lenaqra3 — 3000 posts, 910 book files (ok)
- llllTTTWW — 3000 posts, 538 book files (ok)
- lovekotob — 3000 posts, 2745 book files (ok)
- M3RFAHALKOTOB — 3000 posts, 1668 book files (ok)
- magazineguy — 80 posts, 77 book files (ok)
- Mahmoud_Salem_5 — 184 posts, 183 book files (ok)
- MaktabaBook — 3000 posts, 1695 book files (ok)
- maktbahnet — 3000 posts, 17 book files (ok)
- maktbapdf — 3000 posts, 2 book files (ok)
- maktph — 3000 posts, 2239 book files (ok)
- megalatnawader — 917 posts, 21 book files (ok)
- mergebooks — 3000 posts, 1118 book files (ok)
- Mohanime — 525 posts, 0 book files (ok)
- Motamayz00n — 193 posts, 128 book files (ok)
- muscatnonfiction — 3000 posts, 1433 book files (ok)
- mybook22 — 3000 posts, 2949 book files (ok)
- MyEnglishChannel — 0 posts, 0 book files (error)
- NewBooksAndEditions — 3000 posts, 1336 book files (ok)
- ni3mehalzoubi — 2217 posts, 1217 book files (ok)
- noorlibrarykids — 3000 posts, 2705 book files (ok)
- novels2n — 3000 posts, 2251 book files (ok)
- Numidia_Library — 3000 posts, 1373 book files (ok)
- OnePageAway — 3000 posts, 1 book files (ok)
- oxford_bookworms_lm — 1868 posts, 326 book files (ok)
- Oxford_Bookwormss — 576 posts, 104 book files (ok)
- OxfordBookwormers — 1773 posts, 191 book files (ok)
- OxfordBookwormsDominoes1 — 1631 posts, 205 book files (ok)
- OxfordReadingTree — 3000 posts, 512 book files (ok)
- palkotob — 3000 posts, 1675 book files (ok)
- pdf_novels — 3000 posts, 1182 book files (ok)
- pdfiat — 203 posts, 106 book files (ok)
- pdfkotab19 — 905 posts, 874 book files (ok)
- PDFnew — 3000 posts, 1582 book files (ok)
- plussheets — 1650 posts, 901 book files (ok)
- pokidz — 2946 posts, 470 book files (ok)
- qra_at — 3000 posts, 1181 book files (ok)
- quwaa — 2790 posts, 1319 book files (ok)
- read00 — 3000 posts, 2985 book files (ok)
- READ4OR — 202 posts, 93 book files (ok)
- Rff404 — 14 posts, 4 book files (ok)
- Sa7eralkutub — 3000 posts, 665 book files (ok)
- safi_book — 3000 posts, 1446 book files (ok)
- samaheltaweelkidsstories — 268 posts, 208 book files (ok)
- SARIQriwayat — 41 posts, 19 book files (ok)
- sciencecamp1 — 3000 posts, 1305 book files (ok)
- scincematerialsMH — 787 posts, 524 book files (ok)
- shamarly — 1100 posts, 375 book files (ok)
- shamela4kindle — 0 posts, 0 book files (error)
- shamela_epub — 0 posts, 0 book files (error)
- shamela_kindle — 0 posts, 0 book files (error)
- ShamelaMakhtota — 0 posts, 0 book files (error)
- soramnqraa — 3000 posts, 2663 book files (ok)
- stories_kids — 149 posts, 31 book files (ok)
- storybooksforkids — 634 posts, 395 book files (ok)
- storybookspdf — 378 posts, 157 book files (ok)
- tahmilkutubwarosaililmiyah — 3000 posts, 2686 book files (ok)
- tea_sugar — 3000 posts, 1906 book files (ok)
- the_romance_hub — 2166 posts, 1973 book files (ok)
- Tleeq — 0 posts, 0 book files (error)
- To_The_Book — 3000 posts, 1752 book files (ok)
- trunkietrunk — 3000 posts, 2928 book files (ok)
- wadistreambooks — 419 posts, 218 book files (ok)
- wessam_pdf — 3000 posts, 2776 book files (ok)
- xepub — 204 posts, 84 book files (ok)
- yasmeenbook — 1046 posts, 633 book files (ok)
- ZAmericanEnglishCourse — 0 posts, 0 book files (error)
- zamericangroup — 0 posts, 0 book files (error)

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
