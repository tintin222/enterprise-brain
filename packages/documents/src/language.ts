/**
 * Lightweight language identification: frequency of function words (stopwords),
 * frequent business-document words (half weight) and a few distinctive letters.
 */

interface LanguageProfile {
  stopwords: string;
  /** Common words in business documents (invoices, CVs, forms), which often have few stopwords. */
  business: string;
  /** Letters that are (nearly) unique to the language. */
  letters?: RegExp;
}

const PROFILES: Record<string, LanguageProfile> = {
  en: {
    stopwords:
      "the and of to in is that for it with as was on are be this by at from or an have has not but which you we they will can our your their been were all would there if more than also into its these about other may such should any only over after who what when",
    business:
      "invoice date total amount number address phone description quantity price payment customer company experience education skills summary page due tax dear regards",
  },
  tr: {
    stopwords:
      "ve bir bu ile için da de olarak olan gibi daha çok en ama veya her şu ne kadar sonra önce ise değil var yok tarafından göre hem ancak üzere ki mi mı mu mü olup oldu olduğu olması ayrıca diğer arasında içinde tüm bazı biz siz bizim sizin onun bunu buna bunun şekilde ilgili edilen yapılan",
    business:
      "fatura tarih tarihi toplam tutar tutarı adres açıklama miktar birim fiyat müşteri ödeme vergi kdv sayın deneyim eğitim yetenekler telefon adı soyadı sayfa sipariş teslim sözleşme madde taraflar hesap banka",
    letters: /[ığşİĞŞ]/g,
  },
  de: {
    stopwords:
      "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sehr wir unter können ich",
    business:
      "rechnung datum betrag summe gesamt menge preis kunde zahlung steuer mwst anschrift telefon erfahrung ausbildung kenntnisse seite",
    letters: /[ßäÄ]/g,
  },
  fr: {
    stopwords:
      "le la les de des et en du un une est que qui dans pour pas par sur au aux avec ce ces il elle sont ou plus ne se nous vous leur été être mais comme sa son ses cette aussi entre sans fait peut tout très lors",
    business: "facture montant prix quantité client paiement adresse téléphone tva expérience formation compétences page",
    letters: /[œèêëîûÈÊ]/g,
  },
  es: {
    stopwords:
      "el la los las de del y en que un una es por con para se no al lo como más pero sus su le ya este esta porque entre cuando muy sin sobre también me hasta hay donde han desde todo nos durante uno les ni contra otros fue ser son está están",
    business: "factura fecha importe cantidad precio cliente pago dirección teléfono iva experiencia educación habilidades página",
    letters: /[ñÑ¿¡]/g,
  },
  it: {
    stopwords:
      "il lo la gli le di del della dei delle che è e un una per in con non si da al alla sono come più ma anche nel nella questo questa ha hanno essere stato tra fra suo sua loro se dove quando molto tutti ogni sul sulla degli",
    business: "fattura data importo quantità prezzo cliente pagamento indirizzo telefono iva esperienza istruzione competenze pagina",
    letters: /[òìù]/g,
  },
  nl: {
    stopwords:
      "de het een en van in is dat op te zijn voor met die niet aan er om ook als bij of door maar over dan zij naar uit wordt worden heeft hebben kan nog wel meer deze dit onze ons uw geen tot werd was zo",
    business: "factuur datum bedrag totaal aantal prijs klant betaling adres telefoon btw ervaring opleiding vaardigheden pagina",
  },
  pt: {
    stopwords:
      "o a os as de do da dos das e em no na nos nas um uma que para com não por se mais como mas ao aos ele ela seu sua ou ser são foi está também pelo pela já entre quando muito sem isso esta este até nós você há",
    business: "fatura data valor quantidade preço cliente pagamento endereço telefone iva experiência educação competências página",
    letters: /[ãõÃÕ]/g,
  },
};

/** Word → [language, weight] entries. */
const LEXICON = new Map<string, [string, number][]>();
for (const [language, profile] of Object.entries(PROFILES)) {
  const add = (words: string, weight: number) => {
    for (const word of new Set(words.split(" "))) {
      const entries = LEXICON.get(word) ?? [];
      if (!entries.some(([l]) => l === language)) entries.push([language, weight]);
      LEXICON.set(word, entries);
    }
  };
  add(profile.stopwords, 1);
  add(profile.business, 0.5);
}

const SAMPLE_CHARS = 20_000;
const MIN_WORDS = 3;
const MIN_LETTERS = 12;
const MIN_SCORE = 2;

/**
 * Best-effort ISO 639-1 code of the text's language (en, tr, de, fr, es, it, nl
 * or pt); undefined for text that is too short or has no clear winner.
 */
export function detectLanguage(text: string): string | undefined {
  const sample = text.slice(0, SAMPLE_CHARS);
  // "İ".toLowerCase() yields "i" + a combining dot, which would split words.
  const words = sample.replace(/İ/g, "i").toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS || words.join("").length < MIN_LETTERS) return undefined;

  const scores = new Map<string, number>();
  for (const word of words) {
    for (const [language, weight] of LEXICON.get(word) ?? []) scores.set(language, (scores.get(language) ?? 0) + weight);
  }
  for (const [language, profile] of Object.entries(PROFILES)) {
    const letters = profile.letters ? (sample.match(profile.letters)?.length ?? 0) : 0;
    if (letters > 0) scores.set(language, (scores.get(language) ?? 0) + Math.min(letters, 10) * 0.5);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < MIN_SCORE || (second && second[1] === best[1])) return undefined;
  return best[0];
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
};

export function languageName(code: string | undefined): string | undefined {
  return code ? (LANGUAGE_NAMES[code] ?? code) : undefined;
}
