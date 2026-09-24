import { mimeFromFileName, MIME } from "./mime.ts";
import { foldText } from "./text.ts";
import type { DocumentType } from "./types.ts";

export interface DocumentTypeResult {
  type: DocumentType;
  /** 0..1 */
  confidence: number;
  /** Keywords that supported the decision, for explanations. */
  signals: string[];
}

type Signal = [pattern: RegExp, weight: number];

interface TypeRule {
  type: DocumentType;
  /** Title words: strong evidence on one of the first lines. */
  title: RegExp;
  fileName: RegExp;
  signals: Signal[];
}

// Patterns run on folded text (lowercase, diacritics stripped, ı → i), so Turkish
// keywords are written without accents and also match text typed without them.
const RULES: TypeRule[] = [
  {
    type: "cv",
    title: /\b(?:curriculum vitae|resume|cv|ozgecmis|lebenslauf)\b/,
    fileName: /(?:^|[\W_])(?:cv|resume|ozgecmis|lebenslauf)(?:[\W_]|$)/,
    signals: [
      [/\bcurriculum vitae\b/, 4],
      [/\bozgecmis\b/, 4],
      [/\bresume\b/, 2],
      [/\b(?:work|professional) experience\b|\bemployment history\b|\bwork history\b/, 2],
      [/\bexperience\b/, 1],
      [/\bis deneyimi\b|\bdeneyim\b|\btecrube\b/, 1.5],
      [/\beducation\b/, 1.5],
      [/\begitim\b|\bogrenim\b/, 1.5],
      [/\bskills\b|\bcompetencies\b/, 1.5],
      [/\byetenekler\b|\bbeceriler\b|\byetkinlikler\b/, 1.5],
      [/\bcertifications?\b|\bsertifika/, 1],
      [/\blanguages\b|\byabanci dil/, 0.5],
      [/\breferences\b|\breferanslar\b/, 0.5],
      [/linkedin\.com\/in\//, 1.5],
      [/\bhobbies\b|\binterests\b|\bhobiler\b|\bilgi alanlari\b/, 1],
      [/\bmilitary service\b|\baskerlik\b/, 1],
      [/\b(?:bsc|msc|mba|phd|bachelor|master)\b|\blisans\b|\buniversit/, 0.5],
    ],
  },
  {
    type: "invoice",
    title: /\b(?:invoice|tax invoice|fatura|e-fatura|e-arsiv fatura|proforma)\b/,
    fileName: /(?:invoice|fatura|(?:^|[\W_])inv[-_ ]?\d)/,
    signals: [
      [/\binvoice\b/, 3],
      [/\bfatura\b/, 3],
      [/\binvoice (?:no|number|date|#)|\binvoice #/, 2],
      [/\bfatura (?:no|numarasi|tarihi)\b/, 2],
      [/\bvat\b/, 1.5],
      [/\bkdv\b/, 1.5],
      [/\bsub-?total\b|\bara toplam\b/, 1],
      [/\btotal\b|\btoplam\b/, 0.5],
      [/\bdue date\b|\bpayment terms\b|\bvade\b|\bson odeme tarihi\b/, 1],
      [/\bbill(?:ed)? to\b|\binvoice to\b/, 1.5],
      [/\bvergi (?:dairesi|no|numarasi)\b|\bvkn\b|\btckn\b/, 1],
      [/\bettn\b/, 2],
      [/\bamount due\b|\bbalance due\b|\bodenecek tutar\b/, 1.5],
      [/\bunit price\b|\bbirim fiyat/, 0.5],
      [/\bqty\b|\bquantity\b|\bmiktar\b/, 0.5],
      [/\biban\b/, 0.5],
    ],
  },
  {
    type: "purchase-order",
    title: /\b(?:purchase order|satin ?alma siparisi|siparis formu|order form)\b/,
    fileName: /(?:purchase[-_ ]?order|(?:^|[\W_])po[-_ ]?\d|siparis)/,
    signals: [
      [/\bpurchase order\b/, 4],
      [/\bsatin ?alma siparis/, 4],
      [/\bsiparis formu\b/, 2],
      [/\bp\.?o\.? ?(?:number|no|#)/, 2.5],
      [/\bsiparis (?:no|numarasi|tarihi)\b/, 2],
      [/\border (?:date|number)\b/, 1],
      [/\bdelivery date\b|\bteslim tarihi\b|\bteslimat\b/, 1],
      [/\bship to\b|\bdeliver to\b/, 1],
      [/\bplease (?:supply|deliver)\b/, 1.5],
      [/\bvendor\b|\bsupplier\b|\btedarikci\b/, 0.5],
    ],
  },
  {
    type: "receipt",
    title: /\b(?:receipt|sales receipt|payment receipt|makbuz|tahsilat makbuzu)\b/,
    fileName: /(?:^|[\W_])(?:receipt|makbuz|fis)(?:[\W_]|$)/,
    signals: [
      [/\breceipt\b/, 3],
      [/\bmakbuz/, 3],
      [/\bfis (?:no|tarihi)\b/, 2],
      [/\bamount paid\b|\bpayment received\b|\bpaid\b/, 1],
      [/\bthank you for your (?:purchase|order|visit)\b/, 1.5],
      [/\bcash\b|\bchange due\b|\bnakit\b/, 0.5],
      [/\bcard (?:ending|number)\b|\bkredi karti\b|\bvisa\b|\bmastercard\b/, 1],
      [/\bz raporu\b|\byazar ?kasa\b/, 2],
      [/\btransaction (?:id|no)\b|\bauth(?:orization)? code\b|\bislem no\b/, 1],
      [/\bcashier\b|\bkasiyer\b/, 1],
    ],
  },
  {
    type: "contract",
    title: /\b(?:agreement|contract|sozlesme(?:si)?|protokol|memorandum of understanding|nda|terms and conditions)\b/,
    fileName: /(?:contract|agreement|sozlesme|(?:^|[\W_])(?:nda|msa|sla)(?:[\W_]|$))/,
    signals: [
      [/\bagreement\b/, 2.5],
      [/\bcontract\b/, 2],
      [/\bsozlesme/, 3],
      [/\bpart(?:y|ies)\b/, 1.5],
      [/\btaraf(?:lar|i|in)?\b/, 1.5],
      [/\bhereby\b|\bhereinafter\b|\bhereto\b/, 1.5],
      [/\bgoverning law\b|\bapplicable law\b/, 2],
      [/\bwhereas\b/, 1.5],
      [/\bin witness whereof\b/, 2],
      [/\bterminat(?:e|ion)\b/, 1],
      [/\bfesih\b|\bfeshi\b/, 1.5],
      [/\bconfidential(?:ity)?\b|\bgizlilik\b/, 0.5],
      [/\buyusmazlik|\byetkili mahkeme|\bicra daireleri\b/, 2],
      [/\bmadde \d+\b/, 1],
      [/\b(?:article|clause) \d+\b/, 1],
      [/\beffective date\b|\byururluk\b/, 1],
      [/\bobligations\b|\byukumluluk/, 1],
      [/\bindemnif/, 1],
      [/\bsignature\b|\bsigned\b|\bimza\b/, 0.5],
    ],
  },
  {
    type: "delivery-note",
    title: /\b(?:delivery note|dispatch note|packing (?:slip|list)|irsaliye|sevk irsaliyesi|e-irsaliye|waybill)\b/,
    fileName: /(?:delivery[-_ ]?note|irsaliye|packing|waybill|dispatch)/,
    signals: [
      [/\bdelivery note\b/, 4],
      [/\bdispatch note\b|\bpacking (?:slip|list)\b|\bwaybill\b/, 3],
      [/\birsaliye/, 4],
      [/\bsevk (?:tarihi|adresi|irsaliyesi|eden)\b/, 2],
      [/\bdelivered (?:by|to)\b|\breceived by\b|\bgoods received\b/, 1],
      [/\bteslim (?:eden|alan)\b/, 2],
      [/\bshipment\b|\bconsignment\b|\bsevkiyat\b/, 1],
      [/\bplaka\b|\bvehicle\b/, 1],
      [/\bdriver\b|\bsofor\b|\btasiyici\b|\bcarrier\b/, 1],
      [/\bqty\b|\bquantity\b|\bmiktar\b/, 0.5],
    ],
  },
  {
    type: "bank-statement",
    title: /\b(?:(?:bank|account) statement|statement of account|hesap (?:ozeti|ekstresi|hareketleri)|ekstre)\b/,
    fileName: /(?:statement|ekstre|hesap[-_ ]?ozeti|hesap[-_ ]?hareket)/,
    signals: [
      [/\b(?:bank|account) statement\b|\bstatement of account\b/, 4],
      [/\bhesap (?:ozeti|ekstresi|hareketleri)\b/, 4],
      [/\bekstre/, 3],
      [/\b(?:opening|closing|previous|new) balance\b/, 2],
      [/\b(?:acilis|kapanis|devreden|onceki) bakiye/, 2],
      [/\bbakiye\b/, 1],
      [/\bbalance\b/, 1],
      [/\baccount (?:number|no|holder)\b|\bhesap (?:no|numarasi|sahibi)\b/, 1.5],
      [/\bstatement (?:date|period)\b|\bhesap donemi\b/, 1],
      [/\bdebit\b|\bcredit\b|\bborc\b|\balacak\b/, 0.5],
      [/\btransactions?\b|\bislemler\b|\bhareketler\b/, 0.5],
      [/\biban\b/, 0.5],
    ],
  },
  {
    type: "id-document",
    title:
      /\b(?:passport|pasaport|identity card|id card|national identity|kimlik karti|nufus cuzdani|driving licen[cs]e|driver'?s licen[cs]e|surucu belgesi|residence permit)\b/,
    fileName: /(?:passport|pasaport|kimlik|id[-_ ]?card|ehliyet|licen[cs]e)/,
    signals: [
      [/\bpassport\b|\bpasaport\b/, 3],
      [/\bidentity card\b|\bid card\b|\bnational id(?:entity)?\b/, 3],
      [/\bkimlik (?:karti|no)\b|\bnufus cuzdani\b|\bt\.?c\.? kimlik\b/, 3],
      [/\bdriving licen[cs]e\b|\bdriver'?s licen[cs]e\b|\bsurucu belgesi\b|\behliyet\b/, 2.5],
      [/\bdate of birth\b|\bdogum tarihi\b/, 1],
      [/\bplace of birth\b|\bdogum yeri\b/, 1.5],
      [/\bnationality\b|\buyrugu\b/, 1],
      [/\bdate of (?:expiry|issue)\b|\bexpiry date\b|\bson gecerlilik\b|\bgecerlilik tarihi\b/, 1.5],
      [/\bsurname\b|\bsoyadi\b/, 1],
      [/\bgiven names?\b/, 1.5],
      [/\bmother'?s name\b|\bfather'?s name\b|\banne adi\b|\bbaba adi\b/, 1.5],
      // Machine-readable zone of passports and ID cards.
      [/p<[a-z]{3}|(?<![a-z0-9<])[a-z0-9<]{25,44}<</, 3],
    ],
  },
  {
    type: "letter",
    title: /\b(?:cover letter|reference letter|letter of|mektup|dilekce)\b/,
    fileName: /(?:letter|mektup|dilekce)/,
    signals: [
      [/(?:^|\n)[ \t]*dear\b/, 2.5],
      [/\b(?:yours )?(?:sincerely|faithfully)\b|\b(?:best|kind|warm) regards\b/, 2],
      [/(?:^|\n)[ \t]*sayin\b/, 2],
      [/\bsaygilarim(?:la|izla)\b|\barz ederim\b|\bbilgilerinize\b|\bgeregini\b/, 2],
      [/(?:^|\n)[ \t]*(?:subject|re|konu)[ \t]*:/, 1],
      [/\bto whom it may concern\b/, 2.5],
      [/\bilgili makama\b/, 3],
      [/\benclosures?\b/, 0.5],
    ],
  },
  {
    type: "report",
    title: /\b(?:report|rapor(?:u)?|analysis|analiz|assessment|white ?paper)\b/,
    fileName: /(?:report|rapor|analysis|analiz)/,
    signals: [
      [/\breport\b/, 2],
      [/\brapor/, 2],
      [/\bexecutive summary\b|\byonetici ozeti\b/, 2],
      [/\btable of contents\b|\bicindekiler\b/, 1.5],
      [/\bfindings\b|\bbulgular\b/, 1.5],
      [/\brecommendations?\b|\boneriler\b/, 1.5],
      [/\bconclusions?\b|\bsonuc(?:lar)?\b/, 1],
      [/\bmethodology\b|\byontem\b/, 1],
      [/\bq[1-4] \d{4}\b|\bquarterly\b|\bannual\b|\byillik\b|\bceyrek\b/, 1],
      [/\bintroduction\b|\bgiris\b/, 0.5],
      [/\banalysis\b|\banaliz\b/, 0.5],
    ],
  },
];

const SAMPLE_CHARS = 20_000;
const MIN_SCORE = 3;
/** Spreadsheets are "spreadsheet" unless their content is strongly typed (e.g. an Excel invoice). */
const MIN_SCORE_SPREADSHEET = 6;
const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([MIME.xlsx, MIME.xls, MIME.ods, MIME.csv, MIME.tsv]);

/**
 * Classify a document from keyword evidence in English and Turkish: weighted
 * signals in the text, title words on the first lines and the file name.
 */
export function detectDocumentType(
  text: string,
  fileName = "",
  context: { hasSheets?: boolean } = {},
): DocumentTypeResult {
  const folded = foldText(text.slice(0, SAMPLE_CHARS));
  const titleLines = folded
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .filter((line) => line.length <= 60);
  const foldedName = foldText(fileName);

  const scored = RULES.map((rule) => {
    let score = 0;
    const signals: string[] = [];
    for (const [pattern, weight] of rule.signals) {
      const match = pattern.exec(folded);
      if (match) {
        score += weight;
        signals.push(match[0].trim());
      }
    }
    if (titleLines.some((line) => rule.title.test(line))) score += 4;
    if (foldedName && rule.fileName.test(foldedName)) {
      score += 3;
      signals.push(`file name "${fileName}"`);
    }
    return { type: rule.type, score, signals: [...new Set(signals)].slice(0, 8) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const second = scored[1]!;
  const isSpreadsheet = Boolean(context.hasSheets) || SPREADSHEET_MIMES.has(mimeFromFileName(fileName) ?? "");
  if (best.score < (isSpreadsheet ? MIN_SCORE_SPREADSHEET : MIN_SCORE)) {
    return isSpreadsheet
      ? { type: "spreadsheet", confidence: 0.9, signals: ["tabular data"] }
      : { type: "unknown", confidence: 0, signals: [] };
  }
  // Grows with the winning score and shrinks with a close runner-up.
  const confidence = 1 - Math.exp(-(best.score - 0.5 * second.score) / 5);
  return { type: best.type, confidence: Math.round(Math.min(0.99, Math.max(0.05, confidence)) * 100) / 100, signals: best.signals };
}
