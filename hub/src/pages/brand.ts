import { S } from "../strings";
import { escapeHtml } from "./layout";

// The HookCI logo, traced from the design mockups: the hook mark and the wordmark are two separate evenodd
// paths in tenths of a pixel, each cropped tight to its ink. Every page draws the logo from these two paths
// (shared once per page through the defs in shell.ts), so there is one source of path data.

const T = S.site;
const e = escapeHtml;

/** The hook mark, ink box 0 0 997 872. */
export const MARK_D =
	"M500 502C498 502 497 504 497 505 491 515 490 568 489 582 488 621 486 662 472 698 411 857 221 931 83 815 9 752 -23 638 18 548 24 534 31 521 40 509 47 500 58 491 62 480 65 473 62 464 61 457 58 435 62 411 77 394 127 337 221 365 223 444 223 478 210 508 179 524 170 528 161 532 153 539 143 548 136 561 130 574 93 659 161 766 258 742 277 738 299 726 310 708 323 688 305 660 314 638 333 590 392 595 401 554 413 497 417 439 424 381 428 352 438 305 437 277 437 256 397 236 384 213 334 130 372 33 465 5 505 -8 556 6 588 32 625 63 643 108 637 155 633 186 617 215 595 236 585 246 569 255 565 269 562 279 598 550 605 566 610 578 622 584 633 591 652 602 671 612 682 632 699 665 668 694 701 722 712 732 727 739 742 743 778 752 814 741 841 716 888 672 891 592 848 544 835 530 817 526 803 514 773 489 766 433 787 401 800 380 827 367 851 366 869 366 884 371 900 379 960 412 921 460 938 490 944 499 951 507 957 515 973 537 985 560 991 587 1001 628 997 671 984 710 946 821 839 885 723 869 629 856 553 777 528 689 517 649 516 607 512 566 511 556 509 503 500 502ZM538 142C540 141 536 128 535 127 520 87 466 92 462 135 461 148 468 157 477 167 498 189 523 177 536 152 536 151 538 142 538 142Z";

/** The "HookCI" wordmark, ink box 0 0 1590 354. */
export const WORDMARK_D =
	"M589 224C588 224 589 226 589 227 589 232 588 236 588 241 586 259 580 277 571 293 553 321 525 340 493 348 405 370 327 311 329 220 330 185 343 149 369 125 422 77 516 83 561 139 577 159 586 184 588 209 589 213 589 217 589 221 589 222 590 224 589 224ZM875 224C874 224 875 226 875 227 875 232 875 236 874 241 872 258 867 276 858 291 807 377 670 373 627 282 616 258 614 232 616 207 624 84 797 50 857 153 868 171 873 192 875 212 875 215 875 218 875 221 875 222 876 224 875 224ZM1471 263C1469 263 1472 267 1472 269 1471 282 1458 295 1450 303 1426 330 1394 345 1358 351 1264 368 1174 306 1161 210 1154 161 1163 111 1191 71 1244 -8 1370 -25 1440 41 1447 47 1453 55 1458 62 1465 72 1474 83 1465 95 1458 104 1432 114 1421 112 1408 109 1403 94 1394 86 1384 77 1372 70 1359 66 1344 61 1327 61 1312 63 1238 76 1215 164 1238 226 1260 286 1330 312 1384 276 1389 273 1394 268 1398 264 1405 256 1411 244 1421 240 1432 236 1446 245 1456 249 1461 251 1465 253 1468 257 1468 258 1471 263 1471 263ZM227 345C227 343 225 342 225 340 222 331 224 319 224 309 225 286 224 264 224 241 224 232 226 223 224 214 224 211 222 209 221 207 218 206 216 203 213 203 206 202 198 203 191 203 177 203 163 203 149 203 133 203 117 203 101 203 94 203 86 202 79 203 75 204 74 206 71 207 70 210 68 211 68 214 67 223 68 232 68 241 67 265 67 288 67 312 67 320 68 329 67 337 66 340 64 342 63 344 61 345 60 347 57 347 50 348 42 346 34 346 26 347 18 348 10 347 8 347 6 345 4 344 3 342 1 340 1 338 -1 330 1 321 1 314 1 299 0 284 0 269 0 226 0 183 1 141 1 112 1 84 1 55 1 42 -1 29 0 16 1 12 3 10 4 7 6 7 8 5 9 5 18 3 27 5 35 5 42 5 50 4 57 5 60 5 61 7 63 7 64 10 67 11 67 14 69 24 67 34 67 44 67 66 68 88 68 110 68 117 66 125 68 133 68 135 70 137 71 139 74 140 76 143 80 143 87 144 95 143 103 143 119 143 135 143 151 143 163 143 176 143 188 143 196 143 205 145 212 143 216 143 218 140 221 139 221 137 223 136 224 134 225 126 224 118 224 111 224 87 224 64 224 40 224 32 222 22 224 14 225 11 227 10 227 8 230 7 231 5 233 5 236 4 281 4 282 5 285 5 286 7 288 8 289 10 291 12 291 14 293 20 291 27 291 33 291 47 292 60 292 74 292 114 291 154 291 194 291 226 292 258 292 290 292 305 293 320 292 335 292 339 289 341 288 344 286 345 284 347 282 347 278 348 237 348 234 348 231 347 230 345 227 345ZM1005 247C1003 248 1001 247 999 248 995 251 992 255 988 259 972 279 975 298 976 322 976 327 976 333 975 338 975 340 973 342 973 344 971 344 969 346 967 347 964 348 924 348 920 347 918 347 916 345 914 344 913 342 911 340 911 338 909 327 911 309 911 297 911 260 911 223 911 186 911 148 911 110 911 72 911 53 909 34 911 15 911 11 914 9 915 6 917 5 919 3 921 3 928 2 935 4 942 4 950 4 958 3 966 3 968 4 969 5 971 6 973 8 975 10 975 13 978 24 976 37 976 48 976 82 975 115 976 149 976 158 973 175 976 182 976 184 978 185 979 187 982 186 983 188 987 186 994 181 998 173 1003 167 1014 155 1057 103 1068 99 1078 96 1091 98 1101 98 1110 98 1127 95 1135 98 1137 99 1138 101 1139 101 1138 103 1140 105 1138 108 1134 114 1126 119 1120 125 1105 140 1091 157 1076 173 1070 179 1062 185 1058 193 1056 195 1056 198 1055 200 1056 202 1056 205 1057 208 1063 218 1072 227 1078 237 1095 263 1113 288 1130 313 1135 320 1147 332 1149 339 1149 341 1148 343 1149 344 1147 344 1147 346 1145 347 1136 349 1122 347 1112 347 1102 347 1089 350 1079 346 1076 345 1073 342 1071 340 1064 331 1058 320 1052 311 1043 297 1034 284 1025 271 1021 264 1018 256 1013 251 1010 248 1007 248 1005 247ZM1524 344C1523 342 1522 340 1521 338 1520 331 1522 324 1522 317 1522 304 1522 291 1522 278 1522 236 1522 194 1522 152 1522 119 1522 87 1522 54 1522 41 1520 28 1522 15 1522 12 1524 10 1525 8 1527 7 1529 6 1531 5 1540 4 1549 6 1558 5 1565 5 1572 4 1579 5 1582 5 1583 7 1585 8 1587 11 1589 13 1589 17 1590 28 1589 40 1589 52 1589 83 1589 115 1589 146 1590 191 1590 236 1589 281 1589 292 1589 303 1589 314 1589 321 1591 329 1590 335 1589 340 1587 341 1585 345 1583 345 1581 347 1578 347 1572 348 1565 347 1559 347 1549 347 1539 349 1530 347 1528 346 1526 345 1524 344ZM808 223C809 223 808 221 808 220 807 213 807 205 804 197 783 130 693 139 684 208 671 310 791 322 806 242 807 237 807 233 808 228 808 227 808 223 808 223ZM521 222C522 222 521 220 521 219 521 212 520 204 518 196 495 129 406 139 397 207 385 311 509 322 521 236 521 232 521 229 521 225 521 224 520 223 521 222Z";

export const MARK_BOX = { w: 997, h: 872 } as const;
export const WORDMARK_BOX = { w: 1590, h: 354 } as const;

/** The two logo paths, as `defs` content. */
export const LOGO_DEFS = `<path id="bm" fill-rule="evenodd" d="${MARK_D}"/><path id="bw" fill-rule="evenodd" d="${WORDMARK_D}"/>`;

const MARK_ASPECT = (MARK_BOX.h / MARK_BOX.w).toFixed(4);
const WORDMARK_ASPECT = (WORDMARK_BOX.h / WORDMARK_BOX.w).toFixed(4);

/**
 * Logo CSS. Both layouts are one svg whose mark and wordmark are scaled and placed by CSS transforms, so
 * their position is exact to a fraction of a pixel (an html box is snapped to whole pixels, svg content is not).
 * All sizes are unitless pixel numbers.
 *
 * Nav (`.brand`): `--ls` scales the whole logo; `--bmw` mark width, `--bww` wordmark width, `--bgap` gap between
 * them and `--bwy` wordmark drop below the mark top override the `--ls` defaults; `--lx` and `--ly` nudge the
 * logo as a length.
 *
 * Stack (`.stk`): `--smw` mark width, `--sww` wordmark width, `--sgp` gap between them; both are centred, `--smx`
 * and `--swx` nudge each horizontally and `--sy` both vertically.
 */
export const BRAND_CSS = `
.brand{--w1:var(--bmw,calc(387 * var(--ls)));--w2:var(--bww,calc(922 * var(--ls)));--gp:var(--bgap,calc(89 * var(--ls)));--dy:var(--bwy,calc(86 * var(--ls)));display:flex;text-decoration:none;transform:translate(var(--lx,0px),var(--ly))}
.bl{display:block;overflow:visible;width:calc((var(--w1) + var(--gp) + var(--w2)) * 1px);height:calc(var(--w1) * ${MARK_ASPECT} * 1px)}
.bl .m,.stk .m{fill:#fd7129;stroke:#fd7129;stroke-width:5}
.bl .w,.stk .w{fill:#0c121b;stroke:#0c121b;stroke-width:3}
.bl .m{transform:scale(calc(var(--w1) / ${MARK_BOX.w}))}
.bl .w{transform:translate(calc((var(--w1) + var(--gp)) * 1px),calc(var(--dy) * 1px)) scale(calc(var(--w2) / ${WORDMARK_BOX.w}))}
.stk{--k1:var(--smw,100);--k2:var(--sww,129);--kg:var(--sgp,12);--kw:max(var(--k1),var(--k2));display:block;overflow:visible;margin:0 auto;width:calc(var(--kw) * 1px);height:calc((var(--k1) * ${MARK_ASPECT} + var(--kg) + var(--k2) * ${WORDMARK_ASPECT}) * 1px)}
.stk .m{transform:translate(calc(((var(--kw) - var(--k1)) / 2 + var(--smx,0)) * 1px),calc(var(--sy,0) * 1px)) scale(calc(var(--k1) / ${MARK_BOX.w}))}
.stk .w{transform:translate(calc(((var(--kw) - var(--k2)) / 2 + var(--swx,0)) * 1px),calc((var(--k1) * ${MARK_ASPECT} + var(--kg) + var(--sy,0)) * 1px)) scale(calc(var(--k2) / ${WORDMARK_BOX.w}))}
`;

/** The logo link: hook mark plus wordmark in one svg. */
export function brandLink(href: string = new URL(T.docsUrl).origin, external = true): string {
	return (
		`<a class="brand" href="${e(href)}"${external ? ' rel="noopener noreferrer"' : ""} aria-label="${e(T.brand)}">` +
		`<svg class="bl" aria-hidden="true" focusable="false"><use class="m" href="#bm"/><use class="w" href="#bw"/></svg></a>`
	);
}

/** The hook mark above the wordmark, centred, for card headers. */
export function logoStack(): string {
	return `<svg class="stk" role="img" aria-label="${e(T.brand)}" focusable="false"><use class="m" href="#bm"/><use class="w" href="#bw"/></svg>`;
}

/**
 * The account glyph in the app header circle, on the 24 unit icon grid: a head ring above a flat bottomed shoulder
 * block, stroked by the shared `.ic` rules (1.7 stroke at 24px). Traced from the mockups, where it is 24px in the
 * 43px circle of the Repositories page.
 */
export const AVATAR_GLYPH = `<circle cx="12" cy="7.7" r="3.9"/><path d="M4.45 20.9V19.7A4.85 4.85 0 0 1 9.3 14.85H14.7A4.85 4.85 0 0 1 19.55 19.7V20.9Z"/>`;

/**
 * The Slack mark on the 24 unit icon grid, filled with the mockup colours (more saturated than Slack's published
 * palette). The artwork is Slack's 127 unit mark, which the mockups draw unchanged.
 */
export const SLACK_MARK =
	`<g transform="scale(.189)" stroke="none">` +
	`<path fill="#e50f48" d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"/>` +
	`<path fill="#1fc4ee" d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"/>` +
	`<path fill="#17b66c" d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"/>` +
	`<path fill="#fab90e" d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"/>` +
	`</g>`;
