# Index report — telegram-book-index

**Date:** 2026-11-08T17:26:55.264319+00:00 — **Status:** ok — **Mode:** api-backfill — **Duration:** 34s
**Config:** `channels.yaml` — **DB:** `index.db`
**Method:** public t.me/s/ previews only, page by page, metadata only (post text, file name/format/size, post link). No API, no login, no account. Book files are never downloaded.
**Note:** API backfill (manual-only): full history via the MTProto API (Telethon). Credentials from the environment (GitHub Actions secrets); never part of the daily preview job; reads only configured channels/groups, never personal chats. Metadata only — no book files are downloaded.

## Summary so far
- **Channels with data: 51 of 51 walkable** — **206270 posts, 57723 book files** (51930 distinct books)
- **Channels with 0 book files: 8** (drop candidates — see below)
- **Dropped channels: 8** (0 book files in the full first run — history kept in the DB, no longer fetched; see below)
- **Low-density channels: 4** (fewer than 1 book file per 100 posts — kept active, see below)
- **Not yet indexed: 0 channels**
- **Failures this run: 0** (see below; a failed channel keeps its last-good data)
- **Groups indexed from exports: 168** — 0 more groups are commented out in channels.yaml, each needs a Desktop JSON export

## This run
| Channel | New posts | New book files | Scope |
|---|---|---|---|
| All_kinds_Books_Lib (group) | 3000 | 2173 | export |

## Indexed channels (51)

| Channel | Posts | Book files | Scope |
|---|---|---|---|
| [AAT2024F](https://t.me/AAT2024F) | 11 | 0 | — |
| [ahmedsalem81](https://t.me/ahmedsalem81) | 3422 | 244 | — |
| [alm_elmaref](https://t.me/alm_elmaref) | 5489 | 3052 | — |
| [alnoorlib](https://t.me/alnoorlib) | 211 | 47 | — |
| [altfwok](https://t.me/altfwok) | 17056 | 1000 | — |
| [ancientegyptianmagazines](https://t.me/ancientegyptianmagazines) | 1469 | 14 | — |
| [arabicbooks](https://t.me/arabicbooks) | 4775 | 694 | — |
| [arabicEread](https://t.me/arabicEread) | 3 | 0 | — |
| [book_juice](https://t.me/book_juice) | 4808 | 226 | — |
| [book_lovers_s](https://t.me/book_lovers_s) | 10824 | 9216 | — |
| [Bookkn](https://t.me/Bookkn) | 5 | 0 | — |
| [books_p](https://t.me/books_p) | 8154 | 1195 | — |
| [booksguy](https://t.me/booksguy) | 2 | 0 | — |
| [boook1023](https://t.me/boook1023) | 15000 | 4 | — |
| [Course_reserve](https://t.me/Course_reserve) | 172 | 68 | — |
| [daownbook](https://t.me/daownbook) | 3679 | 1794 | — |
| [darkromancenovels](https://t.me/darkromancenovels) | 5079 | 1054 | — |
| [eatae](https://t.me/eatae) | 3904 | 386 | — |
| [eBookRoom](https://t.me/eBookRoom) | 1670 | 0 | — |
| [Ebookspdfdownload](https://t.me/Ebookspdfdownload) | 2 | 0 | — |
| [ekraly](https://t.me/ekraly) | 18011 | 264 | — |
| [Goldenshamelaepub](https://t.me/Goldenshamelaepub) | 15000 | 13469 | — |
| [HAYA_NAQRA](https://t.me/HAYA_NAQRA) | 4583 | 317 | — |
| [hazem_massaod_kindle_books](https://t.me/hazem_massaod_kindle_books) | 1185 | 1608 | — |
| [jad32](https://t.me/jad32) | 192 | 109 | — |
| [kindlbook](https://t.me/kindlbook) | 2983 | 1473 | — |
| [Kindle2](https://t.me/Kindle2) | 534 | 19 | — |
| [kindlearabicbook](https://t.me/kindlearabicbook) | 1059 | 526 | — |
| [KindleBooksRepository](https://t.me/KindleBooksRepository) | 6220 | 3293 | — |
| [ktbibnalqaim](https://t.me/ktbibnalqaim) | 1713 | 89 | — |
| [L_alnader8](https://t.me/L_alnader8) | 18003 | 1732 | — |
| [maktabahzahra](https://t.me/maktabahzahra) | 8877 | 46 | — |
| [Maktademia](https://t.me/Maktademia) | 1 | 0 | — |
| [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) | 1721 | 1 | — |
| [Merciful111Fate](https://t.me/Merciful111Fate) | 20 | 0 | — |
| [Motamayezon7](https://t.me/Motamayezon7) | 65 | 0 | — |
| [n_bhs2](https://t.me/n_bhs2) | 2 | 0 | — |
| [nourbook](https://t.me/nourbook) | 362 | 0 | — |
| [osratouna1](https://t.me/osratouna1) | 4961 | 125 | — |
| [Ouloalelm](https://t.me/Ouloalelm) | 278 | 85 | — |
| [premium_ebooks](https://t.me/premium_ebooks) | 1172 | 0 | — |
| [qurany_is_life](https://t.me/qurany_is_life) | 99 | 13 | — |
| [roayati](https://t.me/roayati) | 530 | 0 | — |
| [rwaiaty4](https://t.me/rwaiaty4) | 18002 | 9019 | — |
| [sharkelmoreeg](https://t.me/sharkelmoreeg) | 2 | 0 | — |
| [Sumarians](https://t.me/Sumarians) | 52 | 0 | — |
| [thedevilshours](https://t.me/thedevilshours) | 2010 | 169 | — |
| [TheEbookStop](https://t.me/TheEbookStop) | 4812 | 1568 | — |
| [twinkling4](https://t.me/twinkling4) | 921 | 287 | — |
| [your_books](https://t.me/your_books) | 126 | 0 | — |
| [zamerican0english](https://t.me/zamerican0english) | 1039 | 344 | — |

## Channels with 0 book files — drop candidates (8)

- [AAT2024F](https://t.me/AAT2024F) — 11 posts, 0 book files
- [Merciful111Fate](https://t.me/Merciful111Fate) — 20 posts, 0 book files
- [n_bhs2](https://t.me/n_bhs2) — 2 posts, 0 book files
- [nourbook](https://t.me/nourbook) — 362 posts, 0 book files
- [roayati](https://t.me/roayati) — 530 posts, 0 book files
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
- [boook1023](https://t.me/boook1023) — 15000 posts, 4 book files (0.000 files/post)
- [maktabahzahra](https://t.me/maktabahzahra) — 8877 posts, 46 book files (0.005 files/post)
- [mamachegucoloringforkids](https://t.me/mamachegucoloringforkids) — 1721 posts, 1 book files (0.001 files/post)

## Giants (uncapped walk is impractical)

- [Sumarians](https://t.me/Sumarians) — newest post id 306117 ≈ ~8.5h for a full walk (indexed 52 posts, oldest reached 1)
- [roayati](https://t.me/roayati) — newest post id 289147 ≈ ~8.0h for a full walk (indexed 530 posts, oldest reached 1)
- [ekraly](https://t.me/ekraly) — newest post id 211509 ≈ ~5.9h for a full walk (indexed 18011 posts, oldest reached 119938)
- [L_alnader8](https://t.me/L_alnader8) — newest post id 80307 ≈ ~2.2h for a full walk (indexed 18003 posts, oldest reached 9679)
- [rwaiaty4](https://t.me/rwaiaty4) — newest post id 54364 ≈ ~1.5h for a full walk (indexed 18002 posts, oldest reached 18940)

## What failed so far

Nothing failed on this run.
- [Ahlahadota](https://t.me/Ahlahadota) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Almootnbe100](https://t.me/Almootnbe100) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ArabicMagazine](https://t.me/ArabicMagazine) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Arabic_PDF](https://t.me/Arabic_PDF) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Arabickindle1](https://t.me/Arabickindle1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ArwaCoffeeBook](https://t.me/ArwaCoffeeBook) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [BOOKCLUB_AR](https://t.me/BOOKCLUB_AR) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [BOOK_HOUSE_INTERNATIONAL](https://t.me/BOOK_HOUSE_INTERNATIONAL) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [BROKAREEMANDME](https://t.me/BROKAREEMANDME) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [BabyEnglishBooks](https://t.me/BabyEnglishBooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [BoOkJuiCe](https://t.me/BoOkJuiCe) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Book_cr2](https://t.me/Book_cr2) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Bookes2023](https://t.me/Bookes2023) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Comics_gate](https://t.me/Comics_gate) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [CoolBooks](https://t.me/CoolBooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [DrKhaledFahmy](https://t.me/DrKhaledFahmy) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Drnonaphrmacy](https://t.me/Drnonaphrmacy) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [EBook_Library](https://t.me/EBook_Library) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [FreeEbookDownloadEnglish](https://t.me/FreeEbookDownloadEnglish) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Free_IslamicBooks](https://t.me/Free_IslamicBooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [G5_Y5](https://t.me/G5_Y5) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [GoldenshamelaGroup](https://t.me/GoldenshamelaGroup) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [HadiAriyanLibrary](https://t.me/HadiAriyanLibrary) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [HindawiFoundationBooks](https://t.me/HindawiFoundationBooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [HoSo0oN](https://t.me/HoSo0oN) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [IslamicLibrary1](https://t.me/IslamicLibrary1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [K3tabi](https://t.me/K3tabi) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [K3tabiCo](https://t.me/K3tabiCo) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [KOTOB_ISLAMIC](https://t.me/KOTOB_ISLAMIC) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [KindleArabicLibrary](https://t.me/KindleArabicLibrary) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [KindleKotob](https://t.me/KindleKotob) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [KotobEslamiah](https://t.me/KotobEslamiah) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [KotobkhanaPDF](https://t.me/KotobkhanaPDF) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [L_alnader1](https://t.me/L_alnader1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [L_alnader14](https://t.me/L_alnader14) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Legacy_1945](https://t.me/Legacy_1945) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [M3RFAHALKOTOB](https://t.me/M3RFAHALKOTOB) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Mahmoud_Salem_5](https://t.me/Mahmoud_Salem_5) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [MaktabaBook](https://t.me/MaktabaBook) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Mohanime](https://t.me/Mohanime) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Motamayz00n](https://t.me/Motamayz00n) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [MyEnglishChannel](https://t.me/MyEnglishChannel) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [NewBooksAndEditions](https://t.me/NewBooksAndEditions) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Numidia_Library](https://t.me/Numidia_Library) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [OnePageAway](https://t.me/OnePageAway) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [OxfordBookwormers](https://t.me/OxfordBookwormers) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [OxfordBookwormsDominoes1](https://t.me/OxfordBookwormsDominoes1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [OxfordReadingTree](https://t.me/OxfordReadingTree) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Oxford_Bookwormss](https://t.me/Oxford_Bookwormss) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [PDFnew](https://t.me/PDFnew) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [READ4OR](https://t.me/READ4OR) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Rff404](https://t.me/Rff404) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [SARIQriwayat](https://t.me/SARIQriwayat) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Sa7eralkutub](https://t.me/Sa7eralkutub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ShamelaMakhtota](https://t.me/ShamelaMakhtota) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [Tleeq](https://t.me/Tleeq) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [To_The_Book](https://t.me/To_The_Book) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ZAmericanEnglishCourse](https://t.me/ZAmericanEnglishCourse) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [aa2tyuq](https://t.me/aa2tyuq) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [abjjad_free](https://t.me/abjjad_free) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [abntaymia3](https://t.me/abntaymia3) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [abo_abdu](https://t.me/abo_abdu) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [adventurers5](https://t.me/adventurers5) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ahn1972](https://t.me/ahn1972) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ahn2323](https://t.me/ahn2323) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [alanbyawardmsr](https://t.me/alanbyawardmsr) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [almaktbhh](https://t.me/almaktbhh) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [almeshkat2023](https://t.me/almeshkat2023) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [almoghmiroonal5msa](https://t.me/almoghmiroonal5msa) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [arabJournalism](https://t.me/arabJournalism) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [art_of_book](https://t.me/art_of_book) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [asseralkotob](https://t.me/asseralkotob) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [audiobooks_kid](https://t.me/audiobooks_kid) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [baz_book](https://t.me/baz_book) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [book100100](https://t.me/book100100) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [book350](https://t.me/book350) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [book4kid](https://t.me/book4kid) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookcheldren](https://t.me/bookcheldren) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookclubarabic](https://t.me/bookclubarabic) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookforbooks](https://t.me/bookforbooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookjunkieb](https://t.me/bookjunkieb) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookpdfepub](https://t.me/bookpdfepub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [books2023](https://t.me/books2023) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [booksforarabs](https://t.me/booksforarabs) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [bookspsychology101](https://t.me/bookspsychology101) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [cambridge_library](https://t.me/cambridge_library) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [comics_link](https://t.me/comics_link) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [cozmoBooks](https://t.me/cozmoBooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ddfkindle](https://t.me/ddfkindle) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [debsibooks](https://t.me/debsibooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [donaldduckcomics](https://t.me/donaldduckcomics) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [dvjhtj](https://t.me/dvjhtj) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [e_books_eng](https://t.me/e_books_eng) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [easymath121](https://t.me/easymath121) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ebookstoread](https://t.me/ebookstoread) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ekraly3](https://t.me/ekraly3) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [englishbooks99](https://t.me/englishbooks99) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [englishcafe_1](https://t.me/englishcafe_1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [freebooksf](https://t.me/freebooksf) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [fun_to_read](https://t.me/fun_to_read) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [isalmickindl](https://t.me/isalmickindl) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [islamicMoral](https://t.me/islamicMoral) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [jame3_masahif](https://t.me/jame3_masahif) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [jazz223k](https://t.me/jazz223k) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [julietbookstoregroup](https://t.me/julietbookstoregroup) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [julietyoya](https://t.me/julietyoya) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [katabataa](https://t.me/katabataa) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kfxarabic](https://t.me/kfxarabic) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [khatabg](https://t.me/khatabg) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kidsbookden](https://t.me/kidsbookden) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kindel4](https://t.me/kindel4) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kindle4kurd](https://t.me/kindle4kurd) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kj7_oi](https://t.me/kj7_oi) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kotobkhana](https://t.me/kotobkhana) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kotokhatab](https://t.me/kotokhatab) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [kottobgededa1977](https://t.me/kottobgededa1977) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ktbmB_othaimen](https://t.me/ktbmB_othaimen) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ktbmfid](https://t.me/ktbmfid) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [l_alnader2](https://t.me/l_alnader2) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [langcours](https://t.me/langcours) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [lastStopbooks](https://t.me/lastStopbooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [lenaqra](https://t.me/lenaqra) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [lenaqra3](https://t.me/lenaqra3) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [llllTTTWW](https://t.me/llllTTTWW) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [lovekotob](https://t.me/lovekotob) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [magazineguy](https://t.me/magazineguy) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [maktbahnet](https://t.me/maktbahnet) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [maktbapdf](https://t.me/maktbapdf) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [maktph](https://t.me/maktph) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [megalatnawader](https://t.me/megalatnawader) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [mergebooks](https://t.me/mergebooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [muscatnonfiction](https://t.me/muscatnonfiction) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [mybook22](https://t.me/mybook22) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [ni3mehalzoubi](https://t.me/ni3mehalzoubi) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [noorlibrarykids](https://t.me/noorlibrarykids) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [novels2n](https://t.me/novels2n) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [oxford_bookworms_lm](https://t.me/oxford_bookworms_lm) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [palkotob](https://t.me/palkotob) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [pdf_novels](https://t.me/pdf_novels) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [pdfiat](https://t.me/pdfiat) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [pdfkotab19](https://t.me/pdfkotab19) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [plussheets](https://t.me/plussheets) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [pokidz](https://t.me/pokidz) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [qra_at](https://t.me/qra_at) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [quwaa](https://t.me/quwaa) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [read00](https://t.me/read00) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [safi_book](https://t.me/safi_book) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [samaheltaweelkidsstories](https://t.me/samaheltaweelkidsstories) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [sciencecamp1](https://t.me/sciencecamp1) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [scincematerialsMH](https://t.me/scincematerialsMH) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamarly](https://t.me/shamarly) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela4kindle](https://t.me/shamela4kindle) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela_epub](https://t.me/shamela_epub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [shamela_kindle](https://t.me/shamela_kindle) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [soramnqraa](https://t.me/soramnqraa) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [stories_kids](https://t.me/stories_kids) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [storybooksforkids](https://t.me/storybooksforkids) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [storybookspdf](https://t.me/storybookspdf) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [tahmilkutubwarosaililmiyah](https://t.me/tahmilkutubwarosaililmiyah) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [tea_sugar](https://t.me/tea_sugar) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [the_romance_hub](https://t.me/the_romance_hub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [trunkietrunk](https://t.me/trunkietrunk) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [wadistreambooks](https://t.me/wadistreambooks) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [wessam_pdf](https://t.me/wessam_pdf) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [xepub](https://t.me/xepub) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [yasmeenbook](https://t.me/yasmeenbook) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)
- [zamericangroup](https://t.me/zamericangroup) — A wait of 71998 seconds is required (caused by ResolveUsernameRequest) (from an earlier run)

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
- All_kinds_Books_Lib — 3000 posts, 2173 book files (ok)
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
