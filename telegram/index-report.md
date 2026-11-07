# Index report — telegram-book-index

**Date:** 2026-11-07T21:06:24.021079+00:00 — **Status:** failed — **Mode:** api-backfill — **Duration:** 1s
**Config:** `channels.yaml` — **DB:** `index.db`
**Method:** public t.me/s/ previews only, page by page, metadata only (post text, file name/format/size, post link). No API, no login, no account. Book files are never downloaded.
**Note:** API backfill (manual-only): full history via the MTProto API (Telethon). Credentials from the environment (GitHub Actions secrets); never part of the daily preview job; reads only configured channels/groups, never personal chats. Metadata only — no book files are downloaded.

## Summary so far
- **Channels with data: 51 of 51 walkable** — **186213 posts, 50275 book files** (45199 distinct books)
- **Channels with 0 book files: 8** (drop candidates — see below)
- **Dropped channels: 8** (0 book files in the full first run — history kept in the DB, no longer fetched; see below)
- **Low-density channels: 4** (fewer than 1 book file per 100 posts — kept active, see below)
- **Not yet indexed: 0 channels**
- **Failures this run: 211** (see below; a failed channel keeps its last-good data)
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
| [darkromancenovels](https://t.me/darkromancenovels) | 0 | 0 | api-backfill |
| [thedevilshours](https://t.me/thedevilshours) | 0 | 0 | api-backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 0 | 0 | api-backfill |
| [ekraly](https://t.me/ekraly) | 0 | 0 | api-backfill |
| [L_alnader8](https://t.me/L_alnader8) | 0 | 0 | api-backfill |
| [osratouna1](https://t.me/osratouna1) | 0 | 0 | api-backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 0 | 0 | api-backfill |
| [AAT2024F](https://t.me/AAT2024F) | 0 | 0 | api-backfill |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 0 | 0 | api-backfill |
| [eatae](https://t.me/eatae) | 0 | 0 | api-backfill |
| [altfwok](https://t.me/altfwok) | 0 | 0 | api-backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 0 | 0 | api-backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 0 | 0 | api-backfill |
| [arabicbooks](https://t.me/arabicbooks) | 0 | 0 | api-backfill |
| [book_juice](https://t.me/book_juice) | 0 | 0 | api-backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 0 | 0 | api-backfill |
| [books_p](https://t.me/books_p) | 0 | 0 | api-backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 0 | 0 | api-backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 0 | 0 | api-backfill |
| [n_bhs2](https://t.me/n_bhs2) | 0 | 0 | api-backfill |
| [nourbook](https://t.me/nourbook) | 0 | 0 | api-backfill |
| [roayati](https://t.me/roayati) | 0 | 0 | api-backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 0 | 0 | api-backfill |
| [Sumarians](https://t.me/Sumarians) | 0 | 0 | api-backfill |
| [twinkling4](https://t.me/twinkling4) | 0 | 0 | api-backfill |
| [your_books](https://t.me/your_books) | 0 | 0 | api-backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 0 | 0 | api-backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 0 | 0 | api-backfill |
| [qurany_is_life](https://t.me/qurany_is_life) | 0 | 0 | api-backfill |
| [jad32](https://t.me/jad32) | 0 | 0 | api-backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 0 | 0 | api-backfill |
| [boook1023](https://t.me/boook1023) | 0 | 0 | api-backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 0 | 0 | api-backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 0 | 0 | api-backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 0 | 0 | api-backfill |
| [Course_reserve](https://t.me/Course_reserve) | 0 | 0 | api-backfill |
| [zamerican0english](https://t.me/zamerican0english) | 0 | 0 | api-backfill |
| All_kinds_Books_Lib (group) | 0 | 0 | export |
| Arabickindle1 (group) | 0 | 0 | export |
| BOOKCLUB_AR (group) | 0 | 0 | export |
| bookclubarabic (group) | 0 | 0 | export |
| booksforarabs (group) | 0 | 0 | export |
| ddfkindle (group) | 0 | 0 | export |
| EBook_Library (group) | 0 | 0 | export |
| jazz223k (group) | 0 | 0 | export |
| kfxarabic (group) | 0 | 0 | export |
| kindel4 (group) | 0 | 0 | export |
| kindle4kurd (group) | 0 | 0 | export |
| KindleArabicLibrary (group) | 0 | 0 | export |
| KindleKotob (group) | 0 | 0 | export |
| kotobkhana (group) | 0 | 0 | export |
| pdfiat (group) | 0 | 0 | export |
| xepub (group) | 0 | 0 | export |
| BOOK_HOUSE_INTERNATIONAL (group) | 0 | 0 | export |
| bookjunkieb (group) | 0 | 0 | export |
| bookpdfepub (group) | 0 | 0 | export |
| bookspsychology101 (group) | 0 | 0 | export |
| CoolBooks (group) | 0 | 0 | export |
| e_books_eng (group) | 0 | 0 | export |
| ebookstoread (group) | 0 | 0 | export |
| englishbooks99 (group) | 0 | 0 | export |
| FreeEbookDownloadEnglish (group) | 0 | 0 | export |
| Legacy_1945 (group) | 0 | 0 | export |
| muscatnonfiction (group) | 0 | 0 | export |
| OnePageAway (group) | 0 | 0 | export |
| oxford_bookworms_lm (group) | 0 | 0 | export |
| Oxford_Bookwormss (group) | 0 | 0 | export |
| OxfordBookwormers (group) | 0 | 0 | export |
| OxfordBookwormsDominoes1 (group) | 0 | 0 | export |
| OxfordReadingTree (group) | 0 | 0 | export |
| storybookspdf (group) | 0 | 0 | export |
| the_romance_hub (group) | 0 | 0 | export |
| trunkietrunk (group) | 0 | 0 | export |
| adventurers5 (group) | 0 | 0 | export |
| Ahlahadota (group) | 0 | 0 | export |
| almoghmiroonal5msa (group) | 0 | 0 | export |
| Arabic_PDF (group) | 0 | 0 | export |
| bookcheldren (group) | 0 | 0 | export |
| Mahmoud_Salem_5 (group) | 0 | 0 | export |
| maktph (group) | 0 | 0 | export |
| noorlibrarykids (group) | 0 | 0 | export |
| pokidz (group) | 0 | 0 | export |
| samaheltaweelkidsstories (group) | 0 | 0 | export |
| Comics_gate (group) | 0 | 0 | export |
| comics_link (group) | 0 | 0 | export |
| donaldduckcomics (group) | 0 | 0 | export |
| Mohanime (group) | 0 | 0 | export |
| BabyEnglishBooks (group) | 0 | 0 | export |
| book4kid (group) | 0 | 0 | export |
| stories_kids (group) | 0 | 0 | export |
| storybooksforkids (group) | 0 | 0 | export |
| audiobooks_kid (group) | 0 | 0 | export |
| easymath121 (group) | 0 | 0 | export |
| G5_Y5 (group) | 0 | 0 | export |
| kidsbookden (group) | 0 | 0 | export |
| plussheets (group) | 0 | 0 | export |
| sciencecamp1 (group) | 0 | 0 | export |
| scincematerialsMH (group) | 0 | 0 | export |
| ArabicMagazine (group) | 0 | 0 | export |
| arabJournalism (group) | 0 | 0 | export |
| magazineguy (group) | 0 | 0 | export |
| megalatnawader (group) | 0 | 0 | export |
| aa2tyuq (group) | 0 | 0 | export |
| abo_abdu (group) | 0 | 0 | export |
| ahn1972 (group) | 0 | 0 | export |
| ahn2323 (group) | 0 | 0 | export |
| alanbyawardmsr (group) | 0 | 0 | export |
| almaktbhh (group) | 0 | 0 | export |
| Almootnbe100 (group) | 0 | 0 | export |
| art_of_book (group) | 0 | 0 | export |
| ArwaCoffeeBook (group) | 0 | 0 | export |
| asseralkotob (group) | 0 | 0 | export |
| book100100 (group) | 0 | 0 | export |
| book350 (group) | 0 | 0 | export |
| Book_cr2 (group) | 0 | 0 | export |
| Bookes2023 (group) | 0 | 0 | export |
| bookforbooks (group) | 0 | 0 | export |
| BoOkJuiCe (group) | 0 | 0 | export |
| books2023 (group) | 0 | 0 | export |
| BROKAREEMANDME (group) | 0 | 0 | export |
| cozmoBooks (group) | 0 | 0 | export |
| debsibooks (group) | 0 | 0 | export |
| DrKhaledFahmy (group) | 0 | 0 | export |
| ekraly3 (group) | 0 | 0 | export |
| freebooksf (group) | 0 | 0 | export |
| fun_to_read (group) | 0 | 0 | export |
| HadiAriyanLibrary (group) | 0 | 0 | export |
| HindawiFoundationBooks (group) | 0 | 0 | export |
| HoSo0oN (group) | 0 | 0 | export |
| julietyoya (group) | 0 | 0 | export |
| katabataa (group) | 0 | 0 | export |
| khatabg (group) | 0 | 0 | export |
| KotobkhanaPDF (group) | 0 | 0 | export |
| kotokhatab (group) | 0 | 0 | export |
| kottobgededa1977 (group) | 0 | 0 | export |
| L_alnader1 (group) | 0 | 0 | export |
| L_alnader14 (group) | 0 | 0 | export |
| l_alnader2 (group) | 0 | 0 | export |
| lastStopbooks (group) | 0 | 0 | export |
| lenaqra (group) | 0 | 0 | export |
| lenaqra3 (group) | 0 | 0 | export |
| llllTTTWW (group) | 0 | 0 | export |
| lovekotob (group) | 0 | 0 | export |
| M3RFAHALKOTOB (group) | 0 | 0 | export |
| MaktabaBook (group) | 0 | 0 | export |
| maktbahnet (group) | 0 | 0 | export |
| maktbapdf (group) | 0 | 0 | export |
| mybook22 (group) | 0 | 0 | export |
| ni3mehalzoubi (group) | 0 | 0 | export |
| novels2n (group) | 0 | 0 | export |
| Numidia_Library (group) | 0 | 0 | export |
| pdf_novels (group) | 0 | 0 | export |
| pdfkotab19 (group) | 0 | 0 | export |
| read00 (group) | 0 | 0 | export |
| Sa7eralkutub (group) | 0 | 0 | export |
| soramnqraa (group) | 0 | 0 | export |
| tea_sugar (group) | 0 | 0 | export |
| To_The_Book (group) | 0 | 0 | export |
| wadistreambooks (group) | 0 | 0 | export |
| wessam_pdf (group) | 0 | 0 | export |
| yasmeenbook (group) | 0 | 0 | export |
| abntaymia3 (group) | 0 | 0 | export |
| almeshkat2023 (group) | 0 | 0 | export |
| baz_book (group) | 0 | 0 | export |
| Drnonaphrmacy (group) | 0 | 0 | export |
| dvjhtj (group) | 0 | 0 | export |
| Free_IslamicBooks (group) | 0 | 0 | export |
| IslamicLibrary1 (group) | 0 | 0 | export |
| islamicMoral (group) | 0 | 0 | export |
| kj7_oi (group) | 0 | 0 | export |
| KOTOB_ISLAMIC (group) | 0 | 0 | export |
| KotobEslamiah (group) | 0 | 0 | export |
| ktbmB_othaimen (group) | 0 | 0 | export |
| ktbmfid (group) | 0 | 0 | export |
| mergebooks (group) | 0 | 0 | export |
| NewBooksAndEditions (group) | 0 | 0 | export |
| palkotob (group) | 0 | 0 | export |
| PDFnew (group) | 0 | 0 | export |
| qra_at (group) | 0 | 0 | export |
| quwaa (group) | 0 | 0 | export |
| safi_book (group) | 0 | 0 | export |
| tahmilkutubwarosaililmiyah (group) | 0 | 0 | export |
| jame3_masahif (group) | 0 | 0 | export |
| shamarly (group) | 0 | 0 | export |
| abjjad_free (group) | 0 | 0 | export |
| julietbookstoregroup (group) | 0 | 0 | export |
| K3tabi (group) | 0 | 0 | export |
| K3tabiCo (group) | 0 | 0 | export |
| Motamayz00n (group) | 0 | 0 | export |
| READ4OR (group) | 0 | 0 | export |
| Rff404 (group) | 0 | 0 | export |
| SARIQriwayat (group) | 0 | 0 | export |
| GoldenshamelaGroup (group) | 0 | 0 | export |
| isalmickindl (group) | 0 | 0 | export |
| shamela4kindle (group) | 0 | 0 | export |
| shamela_epub (group) | 0 | 0 | export |
| shamela_kindle (group) | 0 | 0 | export |
| ShamelaMakhtota (group) | 0 | 0 | export |
| cambridge_library (group) | 0 | 0 | export |
| englishcafe_1 (group) | 0 | 0 | export |
| langcours (group) | 0 | 0 | export |
| MyEnglishChannel (group) | 0 | 0 | export |
| Tleeq (group) | 0 | 0 | export |
| ZAmericanEnglishCourse (group) | 0 | 0 | export |
| zamericangroup (group) | 0 | 0 | export |

## Indexed channels (51)

| Channel | Posts | Book files | Scope |
|---|---|---|---|
| [AAT2024F](https://t.me/AAT2024F) | 11 | 0 | api-backfill |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3421 | 244 | api-backfill |
| [alm_elmaref](https://t.me/alm_elmaref) | 5489 | 3052 | api-backfill |
| [alnoorlib](https://t.me/alnoorlib) | 211 | 47 | api-backfill |
| [altfwok](https://t.me/altfwok) | 15018 | 1000 | api-backfill |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 1469 | 14 | api-backfill |
| [arabicbooks](https://t.me/arabicbooks) | 4775 | 694 | api-backfill |
| [arabicEread](https://t.me/arabicEread) | 3 | 0 | — |
| [book_juice](https://t.me/book_juice) | 4808 | 226 | api-backfill |
| [book_lovers_s](https://t.me/book_lovers_s) | 10824 | 9216 | api-backfill |
| [Bookkn](https://t.me/Bookkn) | 5 | 0 | — |
| [books_p](https://t.me/books_p) | 8153 | 1195 | api-backfill |
| [booksguy](https://t.me/booksguy) | 2 | 0 | — |
| [boook1023](https://t.me/boook1023) | 12000 | 4 | api-backfill |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | api-backfill |
| [daownbook](https://t.me/daownbook) | 3679 | 1794 | api-backfill |
| [darkromancenovels](https://t.me/darkromancenovels) | 5073 | 1054 | api-backfill |
| [eatae](https://t.me/eatae) | 3904 | 386 | api-backfill |
| [eBookRoom](https://t.me/eBookRoom) | 1670 | 0 | — |
| [Ebookspdfdownload](https://t.me/Ebookspdfdownload) | 2 | 0 | — |
| [ekraly](https://t.me/ekraly) | 15008 | 169 | api-backfill |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 12000 | 10469 | api-backfill |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 4582 | 317 | api-backfill |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 1185 | 1608 | api-backfill |
| [jad32](https://t.me/jad32) | 192 | 109 | api-backfill |
| [kindlbook](https://t.me/kindlbook) | 2983 | 1473 | api-backfill |
| [Kindle2](https://t.me/Kindle2) | 534 | 19 | api-backfill |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | api-backfill |
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 6220 | 3293 | api-backfill |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | api-backfill |
| [L_alnader8](https://t.me/L_alnader8) | 15002 | 780 | api-backfill |
| [maktabahzahra](https://t.me/maktabahzahra) | 8877 | 46 | api-backfill |
| [Maktademia](https://t.me/Maktademia) | 1 | 0 | — |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 1721 | 1 | api-backfill |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 20 | 0 | api-backfill |
| [Motamayezon7](https://t.me/Motamayezon7) | 65 | 0 | — |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | api-backfill |
| [nourbook](https://t.me/nourbook) | 362 | 0 | api-backfill |
| [osratouna1](https://t.me/osratouna1) | 4959 | 125 | api-backfill |
| [Ouloalelm](https://t.me/Ouloalelm) | 278 | 85 | api-backfill |
| [premium_ebooks](https://t.me/premium_ebooks) | 1172 | 0 | — |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | api-backfill |
| [roayati](https://t.me/roayati) | 526 | 0 | api-backfill |
| [rwaiaty4](https://t.me/rwaiaty4) | 15002 | 7791 | api-backfill |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | api-backfill |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | api-backfill |
| [thedevilshours](https://t.me/thedevilshours) | 2010 | 169 | api-backfill |
| [TheEbookStop](https://t.me/TheEbookStop) | 4812 | 1568 | api-backfill |
| [twinkling4](https://t.me/twinkling4) | 921 | 287 | api-backfill |
| [your_books](https://t.me/your_books) | 126 | 0 | api-backfill |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | api-backfill |

## Channels with 0 book files — drop candidates (8)

- [AAT2024F](https://t.me/AAT2024F) — 11 posts, 0 book files
- [Merciful111Fate](https://t.me/Merciful111Fate) — 20 posts, 0 book files
- [n_bhs2](https://t.me/n_bhs2) — 2 posts, 0 book files
- [nourbook](https://t.me/nourbook) — 362 posts, 0 book files
- [roayati](https://t.me/roayati) — 526 posts, 0 book files
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
- [boook1023](https://t.me/boook1023) — 12000 posts, 4 book files (0.000 files/post)
- [maktabahzahra](https://t.me/maktabahzahra) — 8877 posts, 46 book files (0.005 files/post)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — 1721 posts, 1 book files (0.001 files/post)

## Giants (uncapped walk is impractical)

- [Sumarians](https://t.me/Sumarians) — newest post id 306117 ≈ ~8.5h for a full walk (indexed 52 posts, oldest reached 1)
- [roayati](https://t.me/roayati) — newest post id 289104 ≈ ~8.0h for a full walk (indexed 526 posts, oldest reached 1)
- [ekraly](https://t.me/ekraly) — newest post id 211471 ≈ ~5.9h for a full walk (indexed 15008 posts, oldest reached 124821)
- [L_alnader8](https://t.me/L_alnader8) — newest post id 80304 ≈ ~2.2h for a full walk (indexed 15002 posts, oldest reached 14700)
- [rwaiaty4](https://t.me/rwaiaty4) — newest post id 54364 ≈ ~1.5h for a full walk (indexed 15002 posts, oldest reached 29813)

## What failed so far

- [KindleBooksRepository](https://t.me/KindleBooksRepository) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [alnoorlib](https://t.me/alnoorlib) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [daownbook](https://t.me/daownbook) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [kindlbook](https://t.me/kindlbook) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Kindle2](https://t.me/Kindle2) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [darkromancenovels](https://t.me/darkromancenovels) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [thedevilshours](https://t.me/thedevilshours) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [TheEbookStop](https://t.me/TheEbookStop) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [ekraly](https://t.me/ekraly) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [L_alnader8](https://t.me/L_alnader8) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [osratouna1](https://t.me/osratouna1) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [rwaiaty4](https://t.me/rwaiaty4) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [AAT2024F](https://t.me/AAT2024F) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [eatae](https://t.me/eatae) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [altfwok](https://t.me/altfwok) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [alm_elmaref](https://t.me/alm_elmaref) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [arabicbooks](https://t.me/arabicbooks) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [book_juice](https://t.me/book_juice) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [book_lovers_s](https://t.me/book_lovers_s) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [books_p](https://t.me/books_p) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [HAYA_NAQRA](https://t.me/HAYA_NAQRA) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [maktabahzahra](https://t.me/maktabahzahra) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [n_bhs2](https://t.me/n_bhs2) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [nourbook](https://t.me/nourbook) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [roayati](https://t.me/roayati) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [sharkelmoreeg](https://t.me/sharkelmoreeg) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Sumarians](https://t.me/Sumarians) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [twinkling4](https://t.me/twinkling4) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [your_books](https://t.me/your_books) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [ahmedsalem81](https://t.me/ahmedsalem81) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [ktbibnalqaim](https://t.me/ktbibnalqaim) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [qurany_is_life](https://t.me/qurany_is_life) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [jad32](https://t.me/jad32) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Merciful111Fate](https://t.me/Merciful111Fate) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [boook1023](https://t.me/boook1023) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Goldenshamelaepub](https://t.me/Goldenshamelaepub) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [kindlearabicbook](https://t.me/kindlearabicbook) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Ouloalelm](https://t.me/Ouloalelm) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [Course_reserve](https://t.me/Course_reserve) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- [zamerican0english](https://t.me/zamerican0english) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- All_kinds_Books_Lib (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Arabickindle1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- BOOKCLUB_AR (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookclubarabic (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- booksforarabs (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ddfkindle (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- EBook_Library (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- jazz223k (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kfxarabic (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kindel4 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kindle4kurd (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- KindleArabicLibrary (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- KindleKotob (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kotobkhana (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- pdfiat (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- xepub (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- BOOK_HOUSE_INTERNATIONAL (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookjunkieb (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookpdfepub (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookspsychology101 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- CoolBooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- e_books_eng (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ebookstoread (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- englishbooks99 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- FreeEbookDownloadEnglish (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Legacy_1945 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- muscatnonfiction (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- OnePageAway (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- oxford_bookworms_lm (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Oxford_Bookwormss (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- OxfordBookwormers (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- OxfordBookwormsDominoes1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- OxfordReadingTree (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- storybookspdf (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- the_romance_hub (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- trunkietrunk (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- adventurers5 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Ahlahadota (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- almoghmiroonal5msa (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Arabic_PDF (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookcheldren (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Mahmoud_Salem_5 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- maktph (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- noorlibrarykids (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- pokidz (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- samaheltaweelkidsstories (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Comics_gate (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- comics_link (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- donaldduckcomics (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Mohanime (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- BabyEnglishBooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- book4kid (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- stories_kids (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- storybooksforkids (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- audiobooks_kid (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- easymath121 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- G5_Y5 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kidsbookden (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- plussheets (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- sciencecamp1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- scincematerialsMH (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ArabicMagazine (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- arabJournalism (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- magazineguy (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- megalatnawader (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- aa2tyuq (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- abo_abdu (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ahn1972 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ahn2323 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- alanbyawardmsr (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- almaktbhh (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Almootnbe100 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- art_of_book (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ArwaCoffeeBook (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- asseralkotob (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- book100100 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- book350 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Book_cr2 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Bookes2023 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- bookforbooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- BoOkJuiCe (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- books2023 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- BROKAREEMANDME (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- cozmoBooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- debsibooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- DrKhaledFahmy (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ekraly3 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- freebooksf (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- fun_to_read (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- HadiAriyanLibrary (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- HindawiFoundationBooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- HoSo0oN (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- julietyoya (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- katabataa (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- khatabg (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- KotobkhanaPDF (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kotokhatab (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kottobgededa1977 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- L_alnader1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- L_alnader14 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- l_alnader2 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- lastStopbooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- lenaqra (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- lenaqra3 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- llllTTTWW (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- lovekotob (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- M3RFAHALKOTOB (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- MaktabaBook (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- maktbahnet (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- maktbapdf (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- mybook22 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ni3mehalzoubi (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- novels2n (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Numidia_Library (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- pdf_novels (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- pdfkotab19 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- read00 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Sa7eralkutub (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- soramnqraa (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- tea_sugar (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- To_The_Book (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- wadistreambooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- wessam_pdf (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- yasmeenbook (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- abntaymia3 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- almeshkat2023 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- baz_book (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Drnonaphrmacy (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- dvjhtj (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Free_IslamicBooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- IslamicLibrary1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- islamicMoral (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- kj7_oi (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- KOTOB_ISLAMIC (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- KotobEslamiah (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ktbmB_othaimen (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ktbmfid (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- mergebooks (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- NewBooksAndEditions (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- palkotob (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- PDFnew (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- qra_at (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- quwaa (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- safi_book (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- tahmilkutubwarosaililmiyah (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- jame3_masahif (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- shamarly (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- abjjad_free (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- julietbookstoregroup (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- K3tabi (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- K3tabiCo (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Motamayz00n (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- READ4OR (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Rff404 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- SARIQriwayat (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- GoldenshamelaGroup (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- isalmickindl (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- shamela4kindle (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- shamela_epub (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- shamela_kindle (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ShamelaMakhtota (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- cambridge_library (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- englishcafe_1 (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- langcours (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- MyEnglishChannel (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- Tleeq (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- ZAmericanEnglishCourse (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)
- zamericangroup (group) — A wait of 72056 seconds is required (caused by ResolveUsernameRequest)

## Not yet indexed — remaining 0 channels

None — every channel in the config has been indexed.

## Not indexable live — groups (need a Desktop JSON export each)

Reason: public groups have no t.me/s/ preview, so live scraping is impossible. Each group needs a Telegram Desktop 'Export chat history' as JSON (result.json), then its entry is uncommented in channels.yaml. No export has been produced yet for most groups.

- aa2tyuq — 0 posts, 0 book files (error)
- abjjad_free — 0 posts, 0 book files (error)
- abntaymia3 — 0 posts, 0 book files (error)
- abo_abdu — 0 posts, 0 book files (error)
- adventurers5 — 0 posts, 0 book files (error)
- Ahlahadota — 0 posts, 0 book files (error)
- ahn1972 — 0 posts, 0 book files (error)
- ahn2323 — 0 posts, 0 book files (error)
- alanbyawardmsr — 0 posts, 0 book files (error)
- All_kinds_Books_Lib — 0 posts, 0 book files (error)
- almaktbhh — 0 posts, 0 book files (error)
- almeshkat2023 — 0 posts, 0 book files (error)
- almoghmiroonal5msa — 0 posts, 0 book files (error)
- Almootnbe100 — 0 posts, 0 book files (error)
- Arabic_PDF — 0 posts, 0 book files (error)
- Arabickindle1 — 0 posts, 0 book files (error)
- ArabicMagazine — 0 posts, 0 book files (error)
- arabJournalism — 0 posts, 0 book files (error)
- art_of_book — 0 posts, 0 book files (error)
- ArwaCoffeeBook — 0 posts, 0 book files (error)
- asseralkotob — 0 posts, 0 book files (error)
- audiobooks_kid — 0 posts, 0 book files (error)
- BabyEnglishBooks — 0 posts, 0 book files (error)
- baz_book — 0 posts, 0 book files (error)
- book100100 — 0 posts, 0 book files (error)
- book350 — 0 posts, 0 book files (error)
- book4kid — 0 posts, 0 book files (error)
- Book_cr2 — 0 posts, 0 book files (error)
- BOOK_HOUSE_INTERNATIONAL — 0 posts, 0 book files (error)
- bookcheldren — 0 posts, 0 book files (error)
- BOOKCLUB_AR — 0 posts, 0 book files (error)
- bookclubarabic — 0 posts, 0 book files (error)
- Bookes2023 — 0 posts, 0 book files (error)
- bookforbooks — 0 posts, 0 book files (error)
- BoOkJuiCe — 0 posts, 0 book files (error)
- bookjunkieb — 0 posts, 0 book files (error)
- bookpdfepub — 0 posts, 0 book files (error)
- books2023 — 0 posts, 0 book files (error)
- booksforarabs — 0 posts, 0 book files (error)
- bookspsychology101 — 0 posts, 0 book files (error)
- BROKAREEMANDME — 0 posts, 0 book files (error)
- cambridge_library — 0 posts, 0 book files (error)
- Comics_gate — 0 posts, 0 book files (error)
- comics_link — 0 posts, 0 book files (error)
- CoolBooks — 0 posts, 0 book files (error)
- cozmoBooks — 0 posts, 0 book files (error)
- ddfkindle — 0 posts, 0 book files (error)
- debsibooks — 0 posts, 0 book files (error)
- donaldduckcomics — 0 posts, 0 book files (error)
- DrKhaledFahmy — 0 posts, 0 book files (error)
- Drnonaphrmacy — 0 posts, 0 book files (error)
- dvjhtj — 0 posts, 0 book files (error)
- e_books_eng — 0 posts, 0 book files (error)
- easymath121 — 0 posts, 0 book files (error)
- EBook_Library — 3000 posts, 2000 book files (error)
- ebookstoread — 0 posts, 0 book files (error)
- ekraly3 — 0 posts, 0 book files (error)
- englishbooks99 — 0 posts, 0 book files (error)
- englishcafe_1 — 0 posts, 0 book files (error)
- Free_IslamicBooks — 0 posts, 0 book files (error)
- freebooksf — 0 posts, 0 book files (error)
- FreeEbookDownloadEnglish — 0 posts, 0 book files (error)
- fun_to_read — 0 posts, 0 book files (error)
- G5_Y5 — 0 posts, 0 book files (error)
- GoldenshamelaGroup — 0 posts, 0 book files (error)
- HadiAriyanLibrary — 0 posts, 0 book files (error)
- HindawiFoundationBooks — 0 posts, 0 book files (error)
- HoSo0oN — 0 posts, 0 book files (error)
- isalmickindl — 0 posts, 0 book files (error)
- IslamicLibrary1 — 0 posts, 0 book files (error)
- islamicMoral — 0 posts, 0 book files (error)
- jame3_masahif — 0 posts, 0 book files (error)
- jazz223k — 0 posts, 0 book files (error)
- julietbookstoregroup — 0 posts, 0 book files (error)
- julietyoya — 0 posts, 0 book files (error)
- K3tabi — 0 posts, 0 book files (error)
- K3tabiCo — 0 posts, 0 book files (error)
- katabataa — 0 posts, 0 book files (error)
- kfxarabic — 0 posts, 0 book files (error)
- khatabg — 0 posts, 0 book files (error)
- kidsbookden — 0 posts, 0 book files (error)
- kindel4 — 0 posts, 0 book files (error)
- kindle4kurd — 0 posts, 0 book files (error)
- KindleArabicLibrary — 0 posts, 0 book files (error)
- KindleKotob — 0 posts, 0 book files (error)
- kj7_oi — 0 posts, 0 book files (error)
- KOTOB_ISLAMIC — 0 posts, 0 book files (error)
- KotobEslamiah — 0 posts, 0 book files (error)
- kotobkhana — 0 posts, 0 book files (error)
- KotobkhanaPDF — 0 posts, 0 book files (error)
- kotokhatab — 0 posts, 0 book files (error)
- kottobgededa1977 — 0 posts, 0 book files (error)
- ktbmB_othaimen — 0 posts, 0 book files (error)
- ktbmfid — 0 posts, 0 book files (error)
- L_alnader1 — 0 posts, 0 book files (error)
- L_alnader14 — 0 posts, 0 book files (error)
- l_alnader2 — 0 posts, 0 book files (error)
- langcours — 0 posts, 0 book files (error)
- lastStopbooks — 0 posts, 0 book files (error)
- Legacy_1945 — 0 posts, 0 book files (error)
- lenaqra — 0 posts, 0 book files (error)
- lenaqra3 — 0 posts, 0 book files (error)
- llllTTTWW — 0 posts, 0 book files (error)
- lovekotob — 0 posts, 0 book files (error)
- M3RFAHALKOTOB — 0 posts, 0 book files (error)
- magazineguy — 0 posts, 0 book files (error)
- Mahmoud_Salem_5 — 0 posts, 0 book files (error)
- MaktabaBook — 0 posts, 0 book files (error)
- maktbahnet — 0 posts, 0 book files (error)
- maktbapdf — 0 posts, 0 book files (error)
- maktph — 0 posts, 0 book files (error)
- megalatnawader — 0 posts, 0 book files (error)
- mergebooks — 0 posts, 0 book files (error)
- Mohanime — 0 posts, 0 book files (error)
- Motamayz00n — 0 posts, 0 book files (error)
- muscatnonfiction — 0 posts, 0 book files (error)
- mybook22 — 0 posts, 0 book files (error)
- MyEnglishChannel — 0 posts, 0 book files (error)
- NewBooksAndEditions — 0 posts, 0 book files (error)
- ni3mehalzoubi — 0 posts, 0 book files (error)
- noorlibrarykids — 0 posts, 0 book files (error)
- novels2n — 0 posts, 0 book files (error)
- Numidia_Library — 0 posts, 0 book files (error)
- OnePageAway — 0 posts, 0 book files (error)
- oxford_bookworms_lm — 0 posts, 0 book files (error)
- Oxford_Bookwormss — 0 posts, 0 book files (error)
- OxfordBookwormers — 0 posts, 0 book files (error)
- OxfordBookwormsDominoes1 — 0 posts, 0 book files (error)
- OxfordReadingTree — 0 posts, 0 book files (error)
- palkotob — 0 posts, 0 book files (error)
- pdf_novels — 0 posts, 0 book files (error)
- pdfiat — 0 posts, 0 book files (error)
- pdfkotab19 — 0 posts, 0 book files (error)
- PDFnew — 0 posts, 0 book files (error)
- plussheets — 0 posts, 0 book files (error)
- pokidz — 0 posts, 0 book files (error)
- qra_at — 0 posts, 0 book files (error)
- quwaa — 0 posts, 0 book files (error)
- read00 — 0 posts, 0 book files (error)
- READ4OR — 0 posts, 0 book files (error)
- Rff404 — 0 posts, 0 book files (error)
- Sa7eralkutub — 0 posts, 0 book files (error)
- safi_book — 0 posts, 0 book files (error)
- samaheltaweelkidsstories — 0 posts, 0 book files (error)
- SARIQriwayat — 0 posts, 0 book files (error)
- sciencecamp1 — 0 posts, 0 book files (error)
- scincematerialsMH — 0 posts, 0 book files (error)
- shamarly — 0 posts, 0 book files (error)
- shamela4kindle — 0 posts, 0 book files (error)
- shamela_epub — 0 posts, 0 book files (error)
- shamela_kindle — 0 posts, 0 book files (error)
- ShamelaMakhtota — 0 posts, 0 book files (error)
- soramnqraa — 0 posts, 0 book files (error)
- stories_kids — 0 posts, 0 book files (error)
- storybooksforkids — 0 posts, 0 book files (error)
- storybookspdf — 0 posts, 0 book files (error)
- tahmilkutubwarosaililmiyah — 0 posts, 0 book files (error)
- tea_sugar — 0 posts, 0 book files (error)
- the_romance_hub — 0 posts, 0 book files (error)
- Tleeq — 0 posts, 0 book files (error)
- To_The_Book — 0 posts, 0 book files (error)
- trunkietrunk — 0 posts, 0 book files (error)
- wadistreambooks — 0 posts, 0 book files (error)
- wessam_pdf — 0 posts, 0 book files (error)
- xepub — 0 posts, 0 book files (error)
- yasmeenbook — 0 posts, 0 book files (error)
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
