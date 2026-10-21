import { S } from "../strings";
import { escapeHtml, type PageInit } from "./layout";

// Server-rendered pages for optional email and password accounts. Self-contained: one inline
// stylesheet, at most one inline script (the password eye toggle), both pinned by SHA-256 in the CSP.

const D = S.account;
const e = escapeHtml;

export interface FormState {
	csrf: string;
	googleEnabled: boolean;
	/** Final user text; escaped here. */
	error?: string;
	email?: string;
}

const FONT = `"Inter", "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** The HookCI logo (hook mark plus wordmark), one path; each use crops it with its own viewBox. */
const LOGO_D = "M 514.5 208.4 C 497.8 212.5, 482.5 225, 475.4 240.4 C 471.4 249.1, 470 255.6, 470 265.4 C 470 281.2, 474.7 293.3, 485.4 304.8 C 488.7 308.3, 493.3 312.3, 495.8 313.7 L 500.2 316.3 499.7 347.9 C 499.2 378.5, 498.1 393.2, 494.5 416 C 492.3 429.6, 492.6 429.1, 487.9 428.4 C 484.1 427.8, 483.8 427.9, 475.4 436.1 C 459.8 451.2, 441.1 471.8, 440.4 474.4 C 439.5 478.2, 440.7 483.3, 443.1 485.9 L 445.2 488.2 441 492.5 C 421 512.9, 385.8 507.6, 368.9 481.7 C 362.4 471.6, 360.5 464.5, 360.5 449.5 C 360.5 437.2, 360.7 436, 364.2 426 C 366.2 420.2, 369.6 411.7, 371.8 406.9 L 375.7 398.4 382.5 397.1 C 395.8 394.7, 405.6 387.5, 411.4 375.9 C 417.2 364.4, 417.1 353.3, 411.3 341.5 C 404 326.4, 385.4 316.4, 369.8 319 C 354.7 321.5, 344 329.4, 337.9 342.5 C 332.7 353.4, 333 365.5, 338.7 376.7 L 341.3 382 337.3 386.7 C 318.2 409.7, 308.9 438.4, 312 465 C 313.5 478.7, 316.3 488.7, 321.5 499.7 C 327.1 511.5, 330.6 516.6, 340.4 526.8 C 369.1 556.6, 412.8 565.8, 450.9 550 C 455 548.3, 462.7 544, 468.1 540.5 C 489.4 526.3, 503.6 507.6, 512.3 482 C 519 462.4, 525 417.5, 525 386 C 525 366.7, 526.7 372.6, 527.3 394.3 C 528.3 428.4, 532.3 461.4, 537.5 479.5 C 544.8 504.8, 560.2 525.6, 583.1 540.9 C 620 565.6, 666.4 562.9, 702.4 534 C 723.9 516.6, 738.8 485.4, 739 457.3 C 739 442.2, 734.6 423.1, 727.8 409.5 C 724.2 402.5, 715.5 389, 711.3 384 L 708.3 380.6 710.7 375.3 C 719.7 355.7, 710.9 332, 691.4 322.8 C 677.6 316.4, 664.1 317.3, 651.3 325.7 C 642.4 331.5, 637.1 339.4, 634.3 350.5 C 629.1 371.6, 644.1 393.3, 666.6 397.1 L 673.5 398.3 678.8 409.8 C 687.5 428.5, 689.2 434.8, 689.8 448.2 C 690.2 458.8, 690 460.8, 687.7 468.3 C 684.3 479, 677.1 489.5, 668.9 495.5 C 650.8 508.8, 626.8 507.9, 611.6 493.3 L 606.9 488.9 609.5 485.9 C 611.4 483.6, 612 481.7, 612 478.4 C 612 473.1, 610.4 469.6, 606 465.5 C 604.2 463.9, 595.8 455, 587.4 445.8 C 578.9 436.6, 570.9 428.8, 569.7 428.4 C 568.5 428, 566.1 427.6, 564.5 427.6 C 561.6 427.5, 561.5 427.4, 560.2 420 C 556.6 398.4, 555.8 386.4, 555.3 352 L 554.8 316.4 560.1 312.9 C 585.1 296.2, 593.6 266.1, 580.9 239.3 C 578.6 234.3, 575.5 230.3, 569.6 224.5 C 560.9 215.8, 553.3 211.4, 542.5 208.5 C 535.5 206.7, 521.6 206.7, 514.5 208.4 M 524 242 C 508.8 244.8, 500.6 261.7, 507.5 275.7 C 511.5 283.6, 519 288, 528.3 288 C 543 287.9, 554.2 274.3, 551 260.3 C 548.3 247.9, 536.2 239.7, 524 242 M 1666.8 312.3 C 1660.4 314.3, 1654.5 319.3, 1651.7 325.1 L 1649 330.4 1649 420.4 L 1649 510.5 1651.4 515.5 C 1653.9 521.1, 1659.2 526.2, 1664.7 528.5 C 1666.6 529.3, 1671.3 530, 1674.9 530 C 1686 530, 1694.6 524.5, 1699.1 514.5 C 1700.9 510.7, 1701 505.4, 1701 420.4 L 1701 330.4 1698.4 325.2 C 1692.7 313.7, 1679.4 308.3, 1666.8 312.3 M 796.5 312.9 C 789.1 314.7, 782 320.6, 778.9 327.5 C 777.1 331.3, 777 336.4, 777 417.9 C 777 481.3, 777.3 505.3, 778.2 508.2 C 779.7 513.2, 786 520.5, 791.4 523.2 C 794.5 524.9, 797.2 525.4, 802.6 525.4 C 813.6 525.3, 821 520.6, 826.6 510 C 828.3 506.9, 828.5 503.2, 829 474 L 829.5 441.5 873.2 441.2 L 917 441 917 471.8 C 917 506.6, 917.5 510.3, 923.6 517 C 930.8 525, 942.8 527.7, 953.2 523.7 C 959 521.5, 966.1 513.9, 967.8 508.2 C 968.7 505.3, 969 481.7, 969 417.8 L 969 331.4 966.2 325.9 C 961.4 316.3, 952 311.3, 940.9 312.3 C 934 312.9, 928.4 315.7, 923.7 320.9 C 917.6 327.7, 917 331.5, 917 364.2 L 917 393 873 393 L 829 393 829 364.2 C 829 329.8, 828.5 327.1, 821 319.8 C 814.2 313.2, 805.4 310.8, 796.5 312.9 M 1316 313.5 C 1309.7 315.5, 1304.2 320.4, 1301.4 326.4 L 1299 331.5 1299 419.1 L 1299 506.6 1301.6 511.8 C 1304.8 518.3, 1309.9 522.6, 1316.9 524.6 C 1328 527.9, 1340.5 523.2, 1346.5 513.6 C 1349.4 508.8, 1349.5 508.2, 1349.8 494.9 L 1350.1 481.2 1356.8 475.4 C 1360.5 472.2, 1364.2 469.1, 1365.1 468.3 C 1366.4 467.2, 1368.2 469.1, 1379.3 483.8 C 1407.5 521.2, 1426.4 544.3, 1430.4 546.4 C 1435.4 548.9, 1443.7 549.6, 1449.5 548 C 1455.6 546.3, 1462.4 540.1, 1464.7 534.2 C 1467 528.1, 1467 518.7, 1464.5 514 C 1463.5 512.1, 1449.4 493.9, 1433.2 473.6 L 1403.7 436.7 1411.1 429.6 C 1415.2 425.7, 1424.9 416.4, 1432.6 409 C 1446.2 395.9, 1446.8 395.2, 1448 389.8 C 1451.5 374.4, 1440.5 360.9, 1424.8 361.1 C 1421.3 361.1, 1417 361.7, 1415.1 362.4 C 1412.9 363.2, 1401.6 373.8, 1380.9 394.5 L 1350 425.5 1350 378.7 C 1350 328.3, 1350 328.7, 1344.6 321.5 C 1338.9 314.1, 1325.6 310.4, 1316 313.5 M 1551 313.6 C 1517.2 317.3, 1491.4 331.4, 1472.8 356.4 C 1449.1 388.3, 1444.9 430.4, 1462 465.6 C 1485.1 513.2, 1538 536.3, 1589.7 521.4 C 1607.7 516.2, 1627.8 503.9, 1633 494.9 C 1636.6 488.5, 1636.6 478, 1632.9 472.4 C 1629.4 467.2, 1613.9 457.9, 1604.8 455.7 C 1602.5 455.1, 1601.2 455.8, 1596.3 460.1 C 1584.1 470.8, 1573.2 475.2, 1559 475.2 C 1547.6 475.2, 1539.2 472.9, 1530.3 467.1 C 1514.1 456.6, 1505 439.8, 1505 420 C 1505 404.3, 1510.1 391.9, 1521.2 380.7 C 1533 368.8, 1549.3 363.3, 1565.8 365.8 C 1575.5 367.3, 1587.4 373, 1595.2 379.9 C 1599.3 383.6, 1601.6 385, 1603.8 385 C 1607.5 385, 1623.9 376.9, 1628.7 372.7 C 1637.3 365.1, 1638.5 351.9, 1631.3 342.2 C 1626.3 335.4, 1607.6 324.1, 1593.6 319.4 C 1581.5 315.2, 1561.2 312.5, 1551 313.6 M 368.3 345.5 C 362.4 348, 358.8 356.8, 360.9 363.3 C 364.3 373.4, 378.1 376.6, 385.6 369.1 C 397.4 357.3, 383.8 338.7, 368.3 345.5 M 667.4 345.4 C 660.5 348.4, 657.2 358.2, 660.7 365 C 668.1 379.3, 690.3 373.1, 688.7 357.1 C 687.6 347, 677.1 341.2, 667.4 345.4 M 1040.7 374 C 1016.2 378.4, 995 394.1, 984.5 415.4 C 978.2 428.1, 976.6 435.1, 976.6 449.5 C 976.5 463.9, 978.1 470.6, 984.4 483.5 C 1000.7 516.5, 1037.7 532.6, 1074.9 522.8 C 1100.8 516.1, 1121.4 495.4, 1128.7 469 C 1131.2 459.9, 1131.2 437.9, 1128.7 429.5 C 1124.1 414.2, 1115.2 400.6, 1103.4 390.8 C 1096.6 385.1, 1082.2 377.7, 1073.5 375.4 C 1066.5 373.6, 1047.6 372.7, 1040.7 374 M 1198 374.5 C 1174.5 379.7, 1154.3 395.2, 1144.5 415.4 C 1138.5 427.7, 1136.7 435.9, 1136.7 450 C 1136.7 463.7, 1139 473.3, 1145 484.9 C 1152.7 499.7, 1163.5 510.2, 1178.5 517.5 C 1191.2 523.6, 1199 525.4, 1213.5 525.4 C 1228 525.4, 1235.8 523.6, 1248.5 517.5 C 1268 508, 1282.3 491.1, 1288.1 470.7 C 1291.5 458.8, 1291.5 438.7, 1288.2 428 C 1280.1 402.4, 1261.9 384.4, 1235.5 376 C 1226.4 373.1, 1207.5 372.4, 1198 374.5 M 1043.7 419.4 C 1035.7 422.3, 1030.7 427, 1025.9 436 C 1023.9 439.8, 1023.5 441.9, 1023.5 449.5 C 1023.5 457, 1023.9 459.2, 1025.8 462.8 C 1031.9 474.2, 1041.6 480.4, 1053.4 480.4 C 1065.3 480.5, 1075 474.5, 1080.8 463.5 C 1083.2 459.1, 1083.5 457.4, 1083.5 449 C 1083.5 440.6, 1083.2 438.9, 1080.8 434.4 C 1077.4 428, 1070.3 421.6, 1064.3 419.6 C 1058.7 417.7, 1048.9 417.6, 1043.7 419.4 M 1205 418.9 C 1197.5 421.2, 1189.9 427.9, 1185.9 435.8 C 1183.9 439.7, 1183.5 442, 1183.5 449.5 C 1183.5 460.2, 1185.7 465.7, 1192.8 472.2 C 1199.2 478, 1205.1 480.4, 1213.5 480.4 C 1222.9 480.4, 1229.5 477.4, 1235.9 470.4 C 1241.8 464, 1244 458, 1244 448.6 C 1244 431.5, 1230.6 417.9, 1214 418.1 C 1210.4 418.1, 1206.4 418.5, 1205 418.9";

type Variant = "login" | "reg" | "center";

const blob = (rx: number, ry: number, at: string, a = 0.26): string =>
	`radial-gradient(ellipse ${rx}px ${ry}px at ${at},rgba(255,106,44,${a}) 0,rgba(255,106,44,${(a * 0.5).toFixed(3)}) 40%,rgba(255,106,44,${(a * 0.14).toFixed(3)}) 75%,rgba(255,106,44,0) 100%)`;

const STYLE = `
:root{--ink:#0f141d;--ink-2:#3b4350;--muted:#6b7280;--line:#e8e9ec;--line-2:#eeeef1;--orange:#ff6a2c;--orange-soft:#fff1ea;--orange-line:#ffb08f}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{position:relative;min-height:100vh;overflow-x:hidden;background:#fafafa;color:var(--ink);font-family:${FONT};font-size:16px;line-height:1.4;letter-spacing:.005em;-webkit-font-smoothing:antialiased}
a{color:inherit}
[hidden]{display:none}
.defs{position:absolute;width:0;height:0;overflow:hidden}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bg,.curves{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.p-login .bg{background:${blob(300, 330, "40px 900px")},${blob(280, 300, "1515px 270px")},${blob(240, 200, "1520px 1010px")}}
.p-reg .bg{background:${blob(340, 380, "60px 820px")},${blob(280, 310, "1515px 300px")},${blob(240, 200, "1510px 1000px")}}
.p-center .bg{background:${blob(290, 340, "70px 760px")},${blob(280, 330, "1500px 345px")},${blob(230, 210, "1515px 985px")}}
.cv{fill:none;stroke:#ff8a54;stroke-width:.8}
.dt{fill:#fd6810}
.ic{display:block;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.p-login{--nh:81px;--nl:100px;--nr:91px;--ls:.139;--ly:7px;--ry:0px;--lk:36px;--nfs:15px;--ph:41px;--pw:14.5px;
--cw:531px;--cr:20px;--px:66px;--pt:34px;--pb:26px;--mkw:106px;--wmw:115px;--g1:12px;--g3:13px;--ts:18px;--tl:24px;--g4:27px;--sg:15px;--sh:52px;--si:26px;--sic:32px;--sfs:18px;
--g5:22px;--dsz:14px;--fg:19px;--lfs:15.5px;--lg:8px;--ih:47px;--ip:48px;--ifs:15.5px;--bh:51px;--bfs:16px;--g6:20px;--g7:17px;--afs:16.5px;--br:10px;--ffs:14.5px;--fp:29px;--g10:21px;
--ft:50px;--hx:100px}
.p-reg{--nh:86px;--nl:96px;--nr:84px;--ls:.136;--ly:0px;--ry:0px;--lk:36px;--nfs:15px;--ph:43px;--pw:14.5px;
--cw:543px;--cr:20px;--px:49px;--pt:35px;--pb:30px;--mkw:85px;--wmw:116px;--g1:12px;--g2:8px;--th:33.4px;--g3:8px;--ts:18px;--tl:22px;--g4:25px;--sg:11px;--sh:55px;--si:22px;--sic:32px;--sfs:17.6px;
--g5:26px;--dsz:14.2px;--fg:19px;--lfs:15.5px;--lg:9px;--ih:48px;--ip:46px;--ifs:15.5px;--bh:52px;--bfs:17.8px;--g6:19px;--g7:20px;--afs:15.5px;--br:10px;--ffs:14.5px;--fp:29px;--g10:26px;
--ft:66px;--hx:106px}
.p-center{--nh:94px;--nl:100px;--nr:86px;--ls:.1432;--ly:-1px;--ry:5px;--lk:42px;--nfs:16.5px;--ph:50px;--pw:15.5px;
--cw:572px;--cr:22px;--px:45px;--pt:41px;--pb:35px;--mkw:104px;--wmw:128px;--g1:14px;--g2:21px;--th:34px;--g3:12px;--ts:20px;--tl:27px;--g4:34px;--sg:15px;--sh:58px;--si:26px;--sic:32px;--sfs:17px;
--g5:28px;--dsz:14px;--fg:36px;--lfs:17px;--lg:12px;--ih:58px;--ip:58px;--ifs:19px;--bh:60px;--bfs:19.5px;--g6:22px;--g7:22px;--afs:16.5px;--br:12px;--ffs:16px;--fp:29px;--g10:28px;
--ft:66px;--hx:106px}
.nav{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;height:var(--nh);padding:0 var(--nr) 0 var(--nl)}
.p-reg .nav,.p-center .nav{border-bottom:1px solid #f0f1f3;background:#fbfbfb}
.brand{display:flex;align-items:flex-start;text-decoration:none;color:var(--ink);transform:translateY(var(--ly))}
.brand .m{width:calc(431px * var(--ls));height:calc(351px * var(--ls));color:var(--orange);fill:currentColor}
.brand .w{width:calc(934px * var(--ls));height:calc(351px * var(--ls));margin-left:calc(32px * var(--ls));color:var(--ink);fill:currentColor}
.navr{display:flex;align-items:center;transform:translateY(var(--ry))}
.links{display:flex;align-items:center;gap:36px;margin-right:42px}
.links a{color:#5f6673;font-size:var(--nfs);text-decoration:none}
.links a:hover{color:var(--ink)}
.pill{display:inline-flex;align-items:center;gap:12px;height:var(--ph);padding:0 18px 0 20px;border:1px solid #e1e3e7;border-radius:999px;background:#fff;color:var(--ink);font-size:var(--pw);font-weight:500;text-decoration:none;box-shadow:0 1px 2px rgba(15,20,29,.03),0 6px 20px rgba(15,20,29,.05)}
.pill .ic{width:22px;height:22px;stroke:none;fill:currentColor}
.stage{position:relative;z-index:2;max-width:1536px;margin:0 auto}
.s-login{display:grid;grid-template-columns:1fr var(--cw) 1fr;padding:4px 0 30px}
.s-reg{display:grid;grid-template-columns:1fr var(--cw) 307px;padding:36px 0 52px}
.s-center{display:flex;justify-content:center;padding:51px 0 58px}
.hero{padding-left:var(--hx);padding-right:20px}
.s-login .hero{grid-column:1;grid-row:1;padding-top:132px;align-self:start}
.s-login .card{grid-column:2;grid-row:1}
.s-login .side{grid-column:3;grid-row:1;align-self:start;padding:352px 0 0 98px}
.s-reg .hero{grid-column:1;grid-row:1;padding-top:96px;align-self:start}
.s-reg .card{grid-column:2;grid-row:1}
.rule{display:block;width:28px;height:4px;border-radius:2px;background:#fd6810}
.s-reg .rule{width:34px}
.hero h2{margin-top:27px;font-size:42.3px;line-height:48px;font-weight:700;letter-spacing:-.02em;color:#0a0e18}
.s-reg .hero h2{margin-top:28px;font-size:53px;line-height:57px;letter-spacing:-.005em}
.hero .lede{margin-top:19px;font-size:20.5px;line-height:28.5px;color:var(--muted);max-width:330px}
.s-reg .hero .lede{margin-top:20px;font-size:23.6px;line-height:32px;max-width:395px}
.feats{list-style:none;display:grid;gap:42px;margin-top:107px}
.s-reg .feats{gap:26px;margin-top:141px}
.feats li,.rf{display:flex;align-items:center;gap:26px}
.ftile{display:grid;place-items:center;flex:none;width:var(--ft);height:var(--ft);border-radius:calc(var(--ft) * .28);background:#fff1ea;color:var(--orange);box-shadow:0 4px 14px rgba(255,106,44,.07)}
.ftile .ic{width:calc(var(--ft) * .5);height:calc(var(--ft) * .5)}
.s-reg .feats li{gap:29px}
.ft strong,.rt strong{display:block;font-size:17.5px;line-height:23px;font-weight:500;color:var(--ink)}
.ft span,.rt p{display:block;font-size:17.5px;line-height:23px;color:#3b4350}
.s-reg .ft strong{font-size:19px}
.s-reg .ft span{font-size:18.5px;color:var(--muted)}
.rfs{list-style:none;display:grid;gap:50px;padding-top:6px}
.rf{align-items:flex-start;gap:26px}
.rf .ftile{width:50px;height:50px}
.rt strong{font-weight:600;line-height:23px;max-width:240px;font-size:17px}
.rt p{margin-top:6px;max-width:222px;font-size:14.5px;line-height:21px;color:var(--muted)}
.card{position:relative;z-index:2;width:var(--cw);padding:var(--pt) var(--px) var(--pb);border:1px solid #eceef1;border-radius:var(--cr);background:#fff;box-shadow:0 1px 2px rgba(15,20,29,.04),0 8px 24px rgba(15,20,29,.06);text-align:center}
.stack{display:flex;flex-direction:column;align-items:center}
.mk{display:block;width:var(--mkw);height:auto;color:var(--orange);fill:currentColor}
.wm{display:block;width:var(--wmw);height:auto;margin-top:var(--g1);color:var(--ink);fill:currentColor}
.ttl{margin-top:var(--g2);font-size:var(--th);line-height:1.15;font-weight:700;letter-spacing:-.015em;color:var(--ink)}
.sub{margin-top:var(--g3);font-size:var(--ts);line-height:var(--tl);color:var(--muted)}
.p-center .sub{max-width:420px;margin-left:auto;margin-right:auto}
.err{margin-top:18px;padding:11px 14px;border:1px solid #ffd3bf;border-radius:10px;background:#fff4ee;color:#a8420f;font-size:14.5px;line-height:1.4;text-align:left}
.sso{display:grid;gap:var(--sg);margin-top:var(--g4)}
.sbtn{display:flex;align-items:center;height:var(--sh);padding:0 var(--si);border:1px solid #e3e6ea;border-radius:var(--br);background:#fff;color:var(--ink);font-size:var(--sfs);font-weight:500;text-decoration:none;box-shadow:0 1px 2px rgba(15,20,29,.04),0 3px 10px rgba(15,20,29,.04)}
.sbtn:hover{background:#fcfcfd}
.sbtn .lg{width:var(--sic);height:var(--sic);stroke:none}
.sbtn span{flex:1;padding-right:var(--sic);text-align:center}
.p-reg .sbtn span{padding:0 0 0 53px;text-align:left}
.p-reg .sbtn .lg{margin-left:-2px}
.sbtn .arr{width:20px;height:20px;color:#3b4350}
.div{display:flex;align-items:center;gap:16px;margin-top:var(--g5);color:#8b92a0;font-size:var(--dsz);line-height:20px}
.div::before,.div::after{content:"";flex:1;height:1px;background:#e8eaed}
.fld{margin-top:var(--fg);text-align:left}
.lrow{display:flex;align-items:baseline;justify-content:space-between}
.lbl{display:block;font-size:var(--lfs);line-height:20px;font-weight:500;color:var(--ink)}
.forgot{color:var(--orange);font-size:14.5px;font-weight:500;text-decoration:none}
.in{position:relative;margin-top:var(--lg)}
.in .ic{position:absolute;left:15px;top:50%;width:20px;height:20px;margin-top:-10px;color:#6b7280;pointer-events:none}
.p-center .in .ic{left:18px;width:24px;height:24px;margin-top:-12px}
input{display:block;width:100%;height:var(--ih);padding:0 14px 0 var(--ip);border:1px solid #e4e7eb;border-radius:var(--br);background:#fff;color:var(--ink);font-family:inherit;font-size:var(--ifs);letter-spacing:inherit;outline:0}
input::placeholder{color:#9ba1ad}
input:focus{border-color:var(--orange-line);box-shadow:0 0 0 3px rgba(255,106,44,.14)}
.eye{position:absolute;top:50%;right:8px;display:grid;place-items:center;width:36px;height:36px;margin-top:-18px;border:0;border-radius:8px;background:none;color:#6b7280;cursor:pointer}
.eye .ic{position:static;width:20px;height:20px;margin:0}
.eye .off{display:none}
.eye[aria-pressed="true"] .on{display:none}
.eye[aria-pressed="true"] .off{display:block}
.eye:hover{color:var(--ink)}
.hint{margin-top:9px;font-size:13.3px;line-height:18px;color:var(--muted);text-align:left}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:var(--bh);margin-top:var(--g6);border:0;border-radius:var(--br);background:#161a23;color:#fff;font-family:inherit;font-size:var(--bfs);font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover{background:#2a303c}
.btn .ic{width:18px;height:18px}
.btn .gh{stroke:none;fill:currentColor}
.alt{margin-top:var(--g7);font-size:var(--afs);line-height:22px;color:var(--muted)}
.alt a{color:var(--orange);font-weight:500;text-decoration:none}
.perm{display:grid;gap:14px;margin-top:16px;padding:15px 20px 18px;border-radius:12px;background:linear-gradient(#f6f7f8,#fcfcfd);text-align:left}
.pr{display:grid;grid-template-columns:22px 1fr;gap:20px}
.pr .ic{width:22px;height:22px;margin-top:1px;color:#2b313c}
.pr strong{display:block;font-size:13.4px;line-height:20px;font-weight:500;color:var(--ink)}
.pr span{display:block;font-size:13.2px;line-height:19px;color:var(--muted)}
.note{display:flex;align-items:center;gap:25px;margin-top:17px;padding:20px;border-radius:14px;background:#fafbfc;text-align:left}
.note .tile{width:58px;height:58px;border-radius:15px}
.note strong{display:block;font-size:var(--afs);line-height:24px;font-weight:500;color:var(--ink)}
.note p{font-size:15.4px;line-height:24px;color:var(--muted);max-width:312px}
.tile{display:grid;place-items:center;flex:none;background:#feebe2;color:var(--orange);border:1px solid #ffd6c2}
.tile .ic{width:28px;height:28px}
.tile.lg{width:84px;height:84px;margin:var(--g2) auto 0;border-radius:24px}
.tile.lg .ic{width:40px;height:40px}
.tile.gh .ic{stroke:none;fill:currentColor}
.back{display:flex;justify-content:center;margin-top:22px;padding:27px 0 32px;border-top:1px solid #eceef1;border-bottom:1px solid #eceef1}
.back a{display:inline-flex;align-items:center;gap:9px;color:#4b5563;font-size:var(--afs);text-decoration:underline;text-underline-offset:3px}
.back .ic{width:18px;height:18px}
.back.one{border-bottom:0}
.foot{display:flex;justify-content:center;margin-top:var(--g10);font-size:var(--ffs)}
.foot.rule2{margin-top:30px;padding-top:27px;border-top:1px solid #e4e6ea}
.foot a{padding:0 var(--fp);color:var(--muted);line-height:16px;text-decoration:none}
.foot a+a{border-left:1px solid #d3d6db}
.foot a:hover{color:var(--ink)}
.msg{margin:20px auto 0;max-width:410px;font-size:var(--ts);line-height:var(--tl);color:var(--muted)}
.msg+.msg{margin-top:12px;font-size:var(--ffs)}
.p-center .card .btn{margin-top:22px}
.kv{margin-top:24px;border:1px solid #eceef1;border-radius:14px;text-align:left}
.kv div{display:flex;justify-content:space-between;gap:16px;padding:14px 18px;font-size:15px;line-height:22px}
.kv div+div{border-top:1px solid #eceef1}
.kv dt{color:var(--muted)}
.kv dd{color:var(--ink);font-weight:500;text-align:right;overflow-wrap:anywhere}
.p-center .card .btn.ghost{border:1px solid #e3e6ea;background:#fff;color:var(--ink)}
.p-center .card .btn.ghost:hover{background:#fcfcfd}
.p-center .card .btn.danger{background:#b4350b}
.p-center .card .btn.danger:hover{background:#962c09}
@media (min-width:901px) and (max-width:1400px){
.hero{padding-left:44px;padding-right:12px}
.s-login .side{padding-left:36px;padding-right:20px}
.s-reg{grid-template-columns:1fr var(--cw) 120px}
.rt p{max-width:190px}
}
@media (max-width:900px){
.p-login,.p-reg,.p-center{--nh:64px;--nl:20px;--nr:20px;--ls:.105;--ly:0px;--ry:0px;--ph:40px;--cw:100%;--cr:18px;--px:24px;--pt:28px;--pb:22px;--mkw:78px;--wmw:104px;--g1:10px;--g2:18px;--th:26px;--g3:10px;--ts:15.5px;--tl:22px;--g4:22px;--sg:12px;--sh:50px;--si:18px;--sic:26px;--sfs:15.5px;--g5:20px;--fg:18px;--ih:48px;--ip:46px;--ifs:16px;--bh:50px;--bfs:16px;--g6:20px;--g7:18px;--afs:15.5px;--ffs:14.5px;--fp:20px;--g10:20px}
.p-reg .nav,.p-center .nav{background:#fbfbfb}
.links,.hero,.side,.curves{display:none}
.pill{width:40px;padding:0;justify-content:center;gap:0}
.pill span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.s-login,.s-reg,.s-center{display:block;padding:12px 16px 28px}
.card{margin:0 auto;max-width:480px}
.p-login .bg,.p-reg .bg,.p-center .bg{background:${blob(200, 230, "-20px 85%", 0.22)},${blob(190, 210, "105% 12%", 0.2)}}
.note .tile{width:52px;height:52px}
.note{gap:16px;padding:16px}
.back{margin-top:22px}
.tile.lg{width:72px;height:72px}
.p-center .in .ic{left:15px;width:20px;height:20px;margin-top:-10px}
}
`;

const SCRIPT = `for(const b of document.querySelectorAll("[data-pw]")){const i=document.getElementById(b.dataset.pw);if(i){b.hidden=false;b.addEventListener("click",()=>{const show=i.type==="password";i.type=show?"text":"password";b.setAttribute("aria-pressed",String(show));b.setAttribute("aria-label",show?b.dataset.hide:b.dataset.show)})}}`;

let styleSource: Promise<string> | undefined;
let scriptSource: Promise<string> | undefined;

/** A CSP hash source: the SHA-256 of the text in base64. */
function sha256Source(text: string): Promise<string> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((digest) => {
		let binary = "";
		for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
		return `'sha256-${btoa(binary)}'`;
	});
}

function styleHash(): Promise<string> {
	styleSource ??= sha256Source(STYLE);
	return styleSource;
}

function scriptHash(): Promise<string> {
	scriptSource ??= sha256Source(SCRIPT);
	return scriptSource;
}

// Stroke icons share a 24x24 grid; the filled brand marks carry their own fills.
const ICONS: Record<string, string> = {
	mail: `<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 8 8 5.5L20 8"/>`,
	lock: `<rect x="5" y="11" width="14" height="10" rx="2.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15.2v2"/>`,
	eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>`,
	"eye-off": `<path d="M3 3l18 18"/><path d="M10.6 6a9 9 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a16 16 0 0 1-2.6 3.3M6.6 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
	bolt: `<path d="M13 2.5 4.5 13.5h6.5L10 21.5l9-11.5h-6.5z"/>`,
	list: `<path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".6"/><circle cx="4.8" cy="12" r=".6"/><circle cx="4.8" cy="17.5" r=".6"/>`,
	chart: `<rect x="3.5" y="12" width="4.6" height="8.5" rx="1.2"/><rect x="9.7" y="4" width="4.6" height="16.5" rx="1.2"/><rect x="15.9" y="8.5" width="4.6" height="12" rx="1.2"/>`,
	shield: `<path d="M12 3 4.8 5.8v5.6c0 4.5 3 8 7.2 9.6 4.2-1.6 7.2-5.1 7.2-9.6V5.8z"/><path d="m9 12 2.3 2.3L15.3 10"/>`,
	folder: `<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`,
	server: `<rect x="4" y="3.5" width="16" height="7" rx="2"/><rect x="4" y="13.5" width="16" height="7" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4M12 17h4"/>`,
	nodes: `<circle cx="12" cy="5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><circle cx="12" cy="13" r="1.6"/><path d="M12 7.3V11.4M10.7 14.1 6.6 16.6M13.3 14.1l4.1 2.5"/>`,
	book: `<path d="M12 6.2C10.3 4.9 8 4.2 5 4.2v13c3 0 5.3.7 7 2 1.7-1.3 4-2 7-2v-13c-3 0-5.3.7-7 2z"/><path d="M12 6.2v13"/>`,
	arrow: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
	back: `<path d="M19 12H5M11 6l-6 6 6 6"/>`,
	check: `<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8 5.2-5.6"/>`,
	alert: `<path d="M12 3.6 2.9 19.4h18.2z"/><path d="M12 10v4.4M12 17.4v.1"/>`,
	github: `<path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>`,
	google: `<path fill="#4285F4" stroke="none" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" stroke="none" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" stroke="none" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.83z"/><path fill="#EA4335" stroke="none" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.9 10.9 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>`,
};

// The GitHub mark is drawn on a 16-unit grid.
const SYMBOL_BOX: Record<string, string> = { github: "0 0 16 16" };

function icon(name: string, cls = ""): string {
	return `<svg class="ic${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

/** Symbol definitions for exactly the icons the page body uses (plus the logo path). */
function defs(body: string): string {
	const used = new Set<string>();
	for (const m of body.matchAll(/href="#i-([a-z-]+)"/g)) used.add(m[1] ?? "");
	let out = `<svg class="defs" aria-hidden="true" focusable="false"><defs><path id="lp" fill-rule="evenodd" d="${LOGO_D}"/>`;
	for (const name of used) {
		const body2 = ICONS[name];
		if (body2) out += `<symbol id="i-${name}" viewBox="${SYMBOL_BOX[name] ?? "0 0 24 24"}">${body2}</symbol>`;
	}
	return `${out}</defs></svg>`;
}

const CURVES: Record<Variant, string> = {
	login:
		`<path class="cv" d="M1024 123C940 130 880 175 835 218S760 262 700 258L500 258"/><circle class="dt" cx="801" cy="235" r="4.6"/>` +
		`<path class="cv" d="M0 365C60 340 140 345 190 367S270 412 336 405L500 405"/><circle class="dt" cx="229" cy="383" r="4.6"/>`,
	reg:
		`<path class="cv" d="M0 330C60 326 100 336 142 358S250 418 330 412S420 390 520 360"/><circle class="dt" cx="142" cy="358" r="4.6"/>` +
		`<path class="cv" d="M1024 172C980 190 940 205 900 238S850 268 780 270"/><circle class="dt" cx="891" cy="243" r="4.6"/>`,
	center:
		`<path class="cv" d="M0 171C70 170 110 190 158 227S250 300 330 305L500 305"/><circle class="dt" cx="158" cy="227" r="4.6"/>` +
		`<path class="cv" d="M520 340L703 340C760 338 790 325 812 307S900 215 960 192S1000 183 1024 183"/><circle class="dt" cx="812" cy="307" r="4.6"/>`,
};

function nav(): string {
	const home = new URL(D.docsUrl).origin;
	return `<header class="nav"><a class="brand" href="${e(home)}" rel="noopener noreferrer" aria-label="${e(D.brand)}">` +
		`<svg class="m" viewBox="309 207 431 351" aria-hidden="true" focusable="false"><use href="#lp"/></svg>` +
		`<svg class="w" viewBox="772 207 934 351" aria-hidden="true" focusable="false"><use href="#lp"/></svg></a>` +
		`<div class="navr"><nav class="links" aria-label="Site">` +
		`<a href="${e(D.docsUrl)}" rel="noopener noreferrer">${e(D.navDocs)}</a>` +
		`<a href="${e(D.pricingUrl)}" rel="noopener noreferrer">${e(D.navPricing)}</a>` +
		`<a href="/support">${e(D.navSupport)}</a></nav>` +
		`<a class="pill" href="${e(D.githubUrl)}" rel="noopener noreferrer">${icon("github")}<span>${e(D.navGithub)}</span></a></div></header>`;
}

const stack = (): string =>
	`<div class="stack"><svg class="mk" viewBox="309 207 431 351" aria-hidden="true" focusable="false"><use href="#lp"/></svg>` +
	`<svg class="wm" viewBox="777 311 924 237" role="img" aria-label="${e(D.brand)}" focusable="false"><use href="#lp"/></svg></div>`;

const footer = (cls = ""): string =>
	`<nav class="foot${cls}" aria-label="Legal"><a href="/privacy">${e(D.footerPrivacy)}</a><a href="/terms">${e(D.footerTerms)}</a><a href="/support">${e(D.footerSupport)}</a></nav>`;

const errorBox = (error: string | undefined): string => (error ? `<div class="err" role="alert">${e(error)}</div>` : "");

const csrfInput = (csrf: string): string => `<input type="hidden" name="csrf" value="${e(csrf)}">`;

const emailField = (f: { email?: string }, label: string = D.emailLabel, placeholder: string = D.emailPlaceholder): string =>
	`<div class="fld"><label class="lbl" for="email">${e(label)}</label><div class="in">${icon("mail")}` +
	`<input id="email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="${e(placeholder)}" value="${e(f.email ?? "")}"></div></div>`;

function passwordField(label: string, placeholder: string, autocomplete: string, aside = ""): string {
	return `<div class="fld"><div class="lrow"><label class="lbl" for="password">${e(label)}</label>${aside}</div><div class="in">${icon("lock")}` +
		`<input id="password" name="password" type="password" autocomplete="${autocomplete}" required placeholder="${e(placeholder)}">` +
		`<button class="eye" type="button" hidden data-pw="password" data-show="${e(D.showPassword)}" data-hide="${e(D.hidePassword)}" aria-label="${e(D.showPassword)}" aria-pressed="false">${icon("eye", "on")}${icon("eye-off", "off")}</button></div></div>`;
}

const submitButton = (label: string): string => `<button class="btn" type="submit">${e(label)}${icon("arrow")}</button>`;

const linkButton = (href: string, label: string): string => `<a class="btn" href="${e(href)}">${e(label)}${icon("arrow")}</a>`;

function ssoButton(href: string, glyph: "google" | "github", label: string, arrow: boolean): string {
	return `<a class="sbtn" href="${href}">${icon(glyph, "lg")}<span>${e(label)}</span>${arrow ? icon("arrow", "arr") : ""}</a>`;
}

function ssoBlock(f: FormState, arrow: boolean): string {
	const google = f.googleEnabled ? ssoButton("/account/google/start", "google", D.continueGoogle, arrow) : "";
	return `<div class="sso">${google}${ssoButton("/app/login", "github", D.continueGithub, arrow)}</div>`;
}

const backLink = (): string => `<div class="back"><a href="/account/login">${icon("back")}${e(D.forgot.back)}</a></div>`;

function document_(title: string, variant: Variant, inner: string, withScript: boolean): string {
	const body = `${nav()}<main class="stage s-${variant}">${inner}</main>`;
	const curves = `<svg class="curves" viewBox="0 0 1024 683" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${CURVES[variant]}</svg>`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${e(title)}</title><style>${STYLE}</style></head>` +
		`<body class="p-${variant}">${defs(body + curves)}<div class="bg" aria-hidden="true"></div>${curves}${body}${withScript ? `<script>${SCRIPT}</script>` : ""}</body></html>`;
}

async function respond(title: string, variant: Variant, inner: string, withScript: boolean, init: PageInit = {}): Promise<Response> {
	const style = await styleHash();
	const script = withScript ? ` script-src ${await scriptHash()};` : "";
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; style-src ${style};${script} base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	for (const cookie of init.cookies ?? []) headers.append("Set-Cookie", cookie);
	return new Response(document_(title, variant, inner, withScript), { status: init.status ?? 200, headers });
}

function features(items: ReadonlyArray<{ icon: string; title: string; body: string }>): string {
	return `<ul class="feats">${items
		.map((it) => `<li><span class="ftile">${icon(it.icon)}</span><span class="ft"><strong>${e(it.title)}</strong><span>${e(it.body)}</span></span></li>`)
		.join("")}</ul>`;
}

export function loginPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const L = D.login;
	const card =
		`<section class="card"><h1 class="sr">${e(L.title)}</h1>${stack()}<p class="sub">${e(L.subtitle)}</p>${errorBox(f.error)}` +
		`${ssoBlock(f, false)}<div class="div">${e(D.dividerOr)}</div>` +
		`<form method="post" action="/account/login">${csrfInput(f.csrf)}${emailField(f)}` +
		`${passwordField(D.passwordLabel, L.passwordPlaceholder, "current-password", `<a class="forgot" href="/account/forgot-password">${e(L.forgot)}</a>`)}` +
		`${submitButton(L.submit)}</form>` +
		`<p class="alt">${e(L.noAccount)} <a href="/account/register">${e(L.signUp)}</a></p>` +
		`<div class="perm"><div class="pr">${icon("book")}<div><strong>${e(L.permissionHeading)}</strong><span>${e(L.permissionBody)}</span></div></div>` +
		`<div class="pr">${icon("shield")}<div><strong>${e(L.privacyHeading)}</strong><span>${e(L.privacyBody)}</span></div></div></div>` +
		`${footer()}</section>`;
	const hero =
		`<aside class="hero"><span class="rule"></span><h2>${e(L.heroLine1)}<br>${e(L.heroLine2)}<br>${e(L.heroLine3)}</h2><p class="lede">${e(L.heroBody)}</p>${features(L.leftFeatures)}</aside>`;
	const side =
		`<aside class="side"><ul class="rfs">${L.rightFeatures
			.map((it) => `<li class="rf"><span class="ftile">${icon(it.icon)}</span><div class="rt"><strong>${e(it.title)}</strong><p>${e(it.body)}</p></div></li>`)
			.join("")}</ul></aside>`;
	return respond(L.title, "login", card + hero + side, true, init);
}

export function registerPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const R = D.register;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(R.heading)}</h1><p class="sub">${e(R.subtitle)}</p>${errorBox(f.error)}` +
		`${ssoBlock(f, true)}<div class="div">${e(D.dividerSignUp)}</div>` +
		`<form method="post" action="/account/register">${csrfInput(f.csrf)}${emailField(f)}` +
		`${passwordField(D.passwordLabel, R.passwordPlaceholder, "new-password")}<p class="hint">${e(D.passwordHint)}</p>` +
		`${submitButton(R.submit)}</form>` +
		`<p class="alt">${e(R.haveAccount)} <a href="/account/login">${e(R.signIn)}</a></p>` +
		`${footer(" rule2")}</section>`;
	const hero =
		`<aside class="hero"><span class="rule"></span><h2>${e(R.heroLine1)}<br>${e(R.heroLine2)}</h2><p class="lede">${e(R.heroBody.replace(/ (\S+)$/, "\u00a0$1"))}</p>${features(R.features)}</aside>`;
	return respond(R.title, "reg", card + hero, true, init);
}

export function forgotPasswordPage(f: FormState, init: PageInit = {}): Promise<Response> {
	const F = D.forgot;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(F.heading)}</h1><p class="sub">${e(F.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/forgot-password">${csrfInput(f.csrf)}${emailField(f)}${submitButton(F.submit)}</form>` +
		`<div class="note"><span class="tile">${icon("mail")}</span><div><strong>${e(F.infoHeading)}</strong><p>${e(F.infoBody)}</p></div></div>` +
		`${backLink()}${footer()}</section>`;
	return respond(F.title, "center", card, false, init);
}

export function resetPasswordPage(f: FormState & { token: string }, init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(R.heading)}</h1><p class="sub">${e(R.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/reset-password">${csrfInput(f.csrf)}<input type="hidden" name="token" value="${e(f.token)}">` +
		`${passwordField(R.passwordLabel, R.passwordPlaceholder, "new-password")}<p class="hint">${e(D.passwordHint)}</p>${submitButton(R.submit)}</form>` +
		`${footer()}</section>`;
	return respond(R.title, "center", card, true, init);
}

/** A centered state card: stacked logo, an icon tile, heading, text, then optional extra markup. */
function stateCard(title: string, glyph: string, tileCls: string, body: string[], extra: string): string {
	return `<section class="card">${stack()}<div class="tile lg${tileCls}">${icon(glyph)}</div><h1 class="ttl">${e(title)}</h1>` +
		`${body.map((text) => `<p class="msg">${e(text)}</p>`).join("")}${extra}${footer()}</section>`;
}

export function checkEmailPage(kind: "register" | "forgot", init: PageInit = {}): Promise<Response> {
	const C = D.checkEmail;
	const title = kind === "register" ? C.registerTitle : C.forgotTitle;
	const text = kind === "register" ? C.registerBody : C.forgotBody;
	return respond(title, "center", stateCard(title, "mail", "", [text, C.spamHint], backLink()), false, init);
}

export function verifyPage(ok: boolean, init: PageInit = {}): Promise<Response> {
	const V = D.verify;
	const inner = ok
		? stateCard(V.okTitle, "check", "", [V.okBody], linkButton("/account/login", V.okButton))
		: stateCard(V.invalidTitle, "alert", "", [V.invalidBody], linkButton("/account/login", V.invalidButton));
	return respond(ok ? V.okTitle : V.invalidTitle, "center", inner, false, init);
}

export function resetDonePage(init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	return respond(R.doneTitle, "center", stateCard(R.doneTitle, "check", "", [R.doneBody], linkButton("/account/login", R.doneButton)), false, init);
}

export function resetInvalidPage(init: PageInit = {}): Promise<Response> {
	const R = D.reset;
	return respond(R.invalidTitle, "center", stateCard(R.invalidTitle, "alert", "", [R.invalidBody], linkButton("/account/forgot-password", R.invalidButton)), false, init);
}

export function connectGithubPage(f: { csrf: string; error?: string }, init: PageInit = {}): Promise<Response> {
	const C = D.connect;
	const form =
		`${errorBox(f.error)}<form method="post" action="/account/connect-github">${csrfInput(f.csrf)}` +
		`<button class="btn" type="submit">${icon("github", "gh")}${e(C.button)}</button></form>`;
	return respond(C.title, "center", stateCard(C.title, "github", " gh", [C.body, C.note], form), false, init);
}

export function connectConflictPage(init: PageInit = {}): Promise<Response> {
	const C = D.connect;
	return respond(C.conflictTitle, "center", stateCard(C.conflictTitle, "alert", "", [C.conflictBody], linkButton("/account/login", C.conflictButton)), false, init);
}

export function verifyConfirmPage(f: { csrf: string; token: string }, init: PageInit = {}): Promise<Response> {
	const V = D.verifyConfirm;
	const form = `<form method="post" action="/account/verify">${csrfInput(f.csrf)}<input type="hidden" name="token" value="${e(f.token)}">${submitButton(V.button)}</form>`;
	return respond(V.title, "center", stateCard(V.title, "mail", "", [V.body], form), false, init);
}

export interface SettingsView {
	csrf: string;
	email: string;
	githubLogin: string | null;
}

export function settingsPage(v: SettingsView, init: PageInit = {}): Promise<Response> {
	const T = D.settings;
	const rows =
		`<dl class="kv"><div><dt>${e(T.emailLabel)}</dt><dd>${e(v.email)}</dd></div>` +
		`<div><dt>${e(T.githubLabel)}</dt><dd>${e(v.githubLogin ?? T.githubNone)}</dd></div></dl>`;
	const connect =
		v.githubLogin === null
			? `<form method="post" action="/account/connect-github">${csrfInput(v.csrf)}<button class="btn ghost" type="submit">${icon("github", "gh")}${e(T.connectGithub)}</button></form>`
			: "";
	const signOut = `<form method="post" action="/account/logout">${csrfInput(v.csrf)}<button class="btn ghost" type="submit">${e(T.signOut)}</button></form>`;
	const remove = `<a class="btn ghost" href="/account/delete">${e(T.delete)}</a>`;
	const back = `<div class="back one"><a href="/app">${icon("back")}${e(T.toRuns)}</a></div>`;
	const card = `<section class="card">${stack()}<h1 class="ttl">${e(T.title)}</h1><p class="sub">${e(T.subtitle)}</p>${rows}${connect}${signOut}${remove}${back}${footer()}</section>`;
	return respond(T.title, "center", card, false, init);
}

export function deleteAccountPage(f: { csrf: string; hasPassword: boolean; error?: string }, init: PageInit = {}): Promise<Response> {
	const X = D.delete;
	const field = f.hasPassword ? passwordField(X.passwordLabel, X.passwordPlaceholder, "current-password") : emailField({}, X.emailLabel, X.emailPlaceholder);
	const cancel = `<div class="back one"><a href="/account/settings">${icon("back")}${e(X.cancel)}</a></div>`;
	const card =
		`<section class="card">${stack()}<h1 class="ttl">${e(X.title)}</h1><p class="sub">${e(X.subtitle)}</p>${errorBox(f.error)}` +
		`<form method="post" action="/account/delete">${csrfInput(f.csrf)}${field}` +
		`<button class="btn danger" type="submit">${e(X.submit)}</button></form>${cancel}${footer()}</section>`;
	return respond(X.title, "center", card, f.hasPassword, init);
}

export function deleteDonePage(init: PageInit = {}): Promise<Response> {
	const X = D.delete;
	return respond(X.doneTitle, "center", stateCard(X.doneTitle, "check", "", [X.doneBody], linkButton("/account/login", X.doneButton)), false, init);
}
