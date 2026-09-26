import { foldText } from "./text.ts";

/**
 * Labels and section headings (English and Turkish) for common business fields.
 * `keys` are field keys that map to the group; `terms` are the labels that locate
 * the value in a document, most specific first. `section` marks groups that are
 * document sections (CV headings) rather than inline labels.
 */
export interface TermGroup {
  id: string;
  keys: string[];
  terms: string[];
  section?: boolean;
}

export const TERM_GROUPS: TermGroup[] = [
  // People and contact details
  {
    id: "name",
    keys: ["name", "full_name", "fullname", "candidate_name", "applicant_name", "person_name", "candidate", "applicant", "ad_soyad", "adi_soyadi", "isim"],
    terms: ["full name", "name surname", "candidate name", "applicant name", "name", "ad soyad", "adı soyadı", "ad-soyad", "isim"],
  },
  {
    id: "email",
    keys: ["email", "e_mail", "email_address", "mail", "contact_email", "eposta", "e_posta"],
    terms: ["email address", "email", "e-mail", "mail", "e-posta", "eposta"],
  },
  {
    id: "phone",
    keys: ["phone", "phone_number", "telephone", "tel", "mobile", "mobile_phone", "gsm", "cell", "contact_phone", "telefon"],
    terms: ["phone number", "phone", "telephone", "mobile", "cell", "tel", "gsm", "telefon", "cep telefonu", "cep"],
  },
  { id: "address", keys: ["address", "adres", "billing_address", "postal_address"], terms: ["address", "adres", "adresi"] },
  { id: "location", keys: ["location", "city", "konum", "sehir"], terms: ["location", "city", "konum", "şehir"] },
  { id: "linkedin", keys: ["linkedin", "linkedin_url", "linkedin_profile"], terms: ["linkedin"] },
  { id: "website", keys: ["website", "url", "web", "homepage", "web_site"], terms: ["website", "web site", "web", "url", "web sitesi"] },
  {
    id: "date_of_birth",
    keys: ["date_of_birth", "birth_date", "birthdate", "dob", "dogum_tarihi"],
    terms: ["date of birth", "birth date", "born", "dob", "doğum tarihi"],
  },
  { id: "nationality", keys: ["nationality", "citizenship", "uyruk"], terms: ["nationality", "citizenship", "uyruğu", "uyruk", "vatandaşlık"] },
  {
    id: "job_title",
    keys: ["job_title", "title", "position", "current_title", "current_position", "headline", "role", "unvan", "pozisyon"],
    terms: ["job title", "current position", "position", "title", "role", "unvan", "ünvan", "pozisyon", "görev"],
  },
  { id: "company", keys: ["company", "company_name", "employer", "organization", "sirket", "firma"], terms: ["company name", "company", "employer", "organization", "şirket", "firma", "kurum"] },

  // CV sections
  {
    id: "summary",
    section: true,
    keys: ["summary", "profile", "about", "about_me", "objective", "professional_summary", "career_objective", "ozet", "hakkimda"],
    terms: ["professional summary", "summary", "professional profile", "profile", "about me", "about", "career objective", "objective", "personal statement", "özet", "profil", "hakkımda", "kariyer hedefi"],
  },
  {
    id: "experience",
    section: true,
    keys: ["experience", "work_experience", "professional_experience", "employment_history", "work_history", "employment", "deneyim", "is_deneyimi"],
    terms: ["work experience", "professional experience", "employment history", "work history", "career history", "experience", "employment", "iş deneyimi", "iş deneyimleri", "iş tecrübesi", "deneyimler", "deneyim", "tecrübe"],
  },
  {
    id: "education",
    section: true,
    keys: ["education", "academic_background", "egitim"],
    terms: ["education and training", "academic background", "education", "eğitim bilgileri", "eğitim durumu", "öğrenim durumu", "eğitim", "öğrenim"],
  },
  {
    id: "skills",
    section: true,
    keys: ["skills", "technical_skills", "key_skills", "core_skills", "competencies", "yetenekler", "beceriler", "yetkinlikler"],
    terms: ["technical skills", "key skills", "core skills", "core competencies", "skills", "competencies", "expertise", "technologies", "teknik beceriler", "teknik yetkinlikler", "yetenekler", "beceriler", "yetkinlikler"],
  },
  {
    id: "languages",
    section: true,
    keys: ["languages", "language_skills", "spoken_languages", "diller", "yabanci_diller"],
    terms: ["language skills", "languages", "yabancı diller", "yabancı dil", "diller", "dil bilgisi"],
  },
  {
    id: "certifications",
    section: true,
    keys: ["certifications", "certificates", "certification", "licenses", "sertifikalar"],
    terms: ["licenses and certifications", "licenses & certifications", "certifications", "certificates", "certification", "sertifikalar", "sertifika"],
  },
  { id: "projects", section: true, keys: ["projects", "projeler"], terms: ["key projects", "projects", "projeler"] },
  { id: "awards", section: true, keys: ["awards", "achievements", "honors"], terms: ["awards", "honors", "achievements", "ödüller", "başarılar"] },
  { id: "publications", section: true, keys: ["publications"], terms: ["publications", "yayınlar"] },
  { id: "courses", section: true, keys: ["courses", "trainings", "kurslar"], terms: ["courses", "training", "kurslar", "seminerler"] },
  { id: "volunteering", section: true, keys: ["volunteering", "volunteer_work"], terms: ["volunteer experience", "volunteering", "volunteer work", "gönüllü çalışmalar"] },
  { id: "interests", section: true, keys: ["interests", "hobbies", "hobiler"], terms: ["interests", "hobbies", "hobiler", "ilgi alanları"] },
  { id: "references", section: true, keys: ["references", "referanslar"], terms: ["references", "referanslar", "referans"] },
  { id: "military_service", section: true, keys: ["military_service", "askerlik"], terms: ["military service", "askerlik durumu", "askerlik"] },
  { id: "driving_license", section: true, keys: ["driving_license", "driving_licence", "ehliyet"], terms: ["driving license", "driving licence", "sürücü belgesi", "ehliyet"] },
  { id: "additional", section: true, keys: ["additional_information"], terms: ["additional information", "other information", "ek bilgiler", "diğer bilgiler"] },
  { id: "personal", section: true, keys: ["personal_information", "personal_details"], terms: ["personal information", "personal details", "kişisel bilgiler"] },
  { id: "contact", section: true, keys: ["contact", "contact_information"], terms: ["contact information", "contact details", "contact", "iletişim bilgileri", "iletişim"] },

  // Invoices and commercial documents
  {
    id: "invoice_number",
    keys: ["invoice_number", "invoice_no", "invoice_id", "invoice_num", "fatura_no", "fatura_numarasi"],
    terms: ["invoice number", "invoice no", "invoice #", "invoice id", "fatura numarası", "fatura no", "belge no", "invoice"],
  },
  {
    id: "invoice_date",
    keys: ["invoice_date", "issue_date", "document_date", "fatura_tarihi"],
    terms: ["invoice date", "date of issue", "issue date", "fatura tarihi", "düzenleme tarihi", "belge tarihi", "date", "tarih"],
  },
  { id: "date", keys: ["date", "tarih"], terms: ["date", "tarih"] },
  {
    id: "due_date",
    keys: ["due_date", "payment_due", "payment_due_date", "vade_tarihi", "son_odeme_tarihi"],
    terms: ["payment due date", "due date", "payment due", "son ödeme tarihi", "vade tarihi", "vade"],
  },
  {
    id: "supplier",
    keys: ["supplier", "vendor", "seller", "supplier_name", "vendor_name", "seller_name", "issuer", "satici", "tedarikci"],
    terms: ["supplier", "vendor", "seller", "from", "satıcı", "tedarikçi", "düzenleyen"],
  },
  {
    id: "customer",
    keys: ["customer", "buyer", "client", "customer_name", "buyer_name", "client_name", "bill_to", "alici", "musteri"],
    terms: ["bill to", "billed to", "invoice to", "sold to", "customer", "buyer", "client", "alıcı", "müşteri", "sayın"],
  },
  {
    id: "tax_id",
    keys: ["tax_id", "tax_number", "tax_no", "vat_number", "vat_id", "vat_no", "tin", "vkn", "vergi_no", "vergi_numarasi", "tckn"],
    terms: ["tax id", "tax number", "tax no", "vat number", "vat reg no", "vat id", "vat no", "tin", "vergi kimlik numarası", "vergi kimlik no", "vergi numarası", "vergi no", "vkn/tckn", "vkn", "tckn"],
  },
  {
    id: "total",
    keys: ["total", "total_amount", "grand_total", "amount_due", "total_due", "invoice_total", "amount", "toplam", "genel_toplam", "odenecek_tutar"],
    terms: ["grand total", "total amount", "amount due", "total due", "balance due", "invoice total", "total", "genel toplam", "ödenecek tutar", "toplam tutar", "toplam"],
  },
  {
    id: "subtotal",
    keys: ["subtotal", "sub_total", "net_amount", "net_total", "ara_toplam"],
    terms: ["subtotal", "sub-total", "sub total", "net amount", "net total", "ara toplam", "mal hizmet toplam tutarı"],
  },
  {
    id: "vat",
    keys: ["vat", "vat_amount", "tax", "tax_amount", "kdv", "kdv_tutari"],
    terms: ["vat amount", "tax amount", "vat", "tax", "hesaplanan kdv", "kdv tutarı", "kdv"],
  },
  { id: "vat_rate", keys: ["vat_rate", "tax_rate", "kdv_orani"], terms: ["vat rate", "tax rate", "kdv oranı", "vat", "kdv"] },
  { id: "iban", keys: ["iban", "iban_number"], terms: ["iban"] },
  { id: "currency", keys: ["currency", "currency_code", "para_birimi"], terms: ["currency", "para birimi", "döviz cinsi"] },
  {
    id: "po_number",
    keys: ["po_number", "po", "purchase_order", "purchase_order_number", "order_number", "order_no", "siparis_no"],
    terms: ["purchase order number", "purchase order no", "po number", "po no", "p.o. number", "p.o. no", "order number", "order no", "sipariş numarası", "sipariş no", "purchase order"],
  },
  { id: "order_date", keys: ["order_date", "po_date", "siparis_tarihi"], terms: ["order date", "po date", "sipariş tarihi", "date", "tarih"] },
  { id: "delivery_date", keys: ["delivery_date", "ship_date", "teslim_tarihi"], terms: ["delivery date", "ship date", "teslim tarihi", "sevk tarihi"] },
  {
    id: "delivery_note_number",
    keys: ["delivery_note_number", "delivery_note_no", "dispatch_number", "waybill_number", "irsaliye_no"],
    terms: ["delivery note number", "delivery note no", "dispatch note no", "waybill no", "irsaliye numarası", "irsaliye no"],
  },
  { id: "recipient", keys: ["recipient", "ship_to", "deliver_to", "consignee", "teslim_alan"], terms: ["ship to", "deliver to", "consignee", "recipient", "teslim alan", "teslim yeri"] },
  { id: "payment_method", keys: ["payment_method", "payment_type", "odeme_sekli"], terms: ["payment method", "paid by", "payment type", "ödeme şekli", "ödeme yöntemi"] },
  { id: "merchant", keys: ["merchant", "store", "store_name", "merchant_name"], terms: ["merchant", "store", "işyeri", "mağaza"] },

  // Bank statements and identity documents
  { id: "account_holder", keys: ["account_holder", "account_name", "hesap_sahibi"], terms: ["account holder", "account name", "hesap sahibi"] },
  { id: "account_number", keys: ["account_number", "account_no", "hesap_no"], terms: ["account number", "account no", "hesap numarası", "hesap no"] },
  { id: "period", keys: ["period", "statement_period", "donem"], terms: ["statement period", "period", "hesap dönemi", "dönem"] },
  {
    id: "opening_balance",
    keys: ["opening_balance", "previous_balance", "acilis_bakiyesi"],
    terms: ["opening balance", "previous balance", "açılış bakiyesi", "devreden bakiye", "önceki bakiye"],
  },
  {
    id: "closing_balance",
    keys: ["closing_balance", "ending_balance", "balance", "kapanis_bakiyesi", "bakiye"],
    terms: ["closing balance", "ending balance", "new balance", "kapanış bakiyesi", "son bakiye", "balance", "bakiye"],
  },
  {
    id: "document_number",
    keys: ["document_number", "passport_number", "id_number", "identity_number", "national_id", "tc_kimlik_no", "kimlik_no"],
    terms: ["document number", "document no", "passport number", "passport no", "id number", "identity number", "national id", "t.c. kimlik no", "tc kimlik no", "kimlik no", "seri no"],
  },
  { id: "surname", keys: ["surname", "last_name", "family_name", "soyad", "soyadi"], terms: ["surname", "last name", "family name", "soyadı", "soyad"] },
  { id: "given_names", keys: ["given_names", "given_name", "first_name", "ad", "adi"], terms: ["given names", "given name", "first name", "adı", "ad"] },
  {
    id: "expiry_date",
    keys: ["expiry_date", "expiration_date", "valid_until", "date_of_expiry", "son_gecerlilik_tarihi"],
    terms: ["date of expiry", "expiry date", "expiration date", "valid until", "son geçerlilik tarihi", "geçerlilik tarihi"],
  },

  // Contracts and letters
  { id: "parties", keys: ["parties", "taraflar"], terms: ["parties", "taraflar"] },
  {
    id: "effective_date",
    keys: ["effective_date", "start_date", "commencement_date", "yururluk_tarihi"],
    terms: ["effective date", "commencement date", "start date", "yürürlük tarihi", "başlangıç tarihi"],
  },
  { id: "end_date", keys: ["end_date", "termination_date", "bitis_tarihi"], terms: ["end date", "termination date", "bitiş tarihi", "sona erme tarihi"] },
  {
    id: "governing_law",
    keys: ["governing_law", "applicable_law", "jurisdiction"],
    terms: ["governing law", "applicable law", "jurisdiction", "uygulanacak hukuk", "yetkili mahkeme"],
  },
  { id: "subject", keys: ["subject", "konu"], terms: ["subject", "re", "konu"] },
];

const GROUP_BY_KEY = new Map<string, TermGroup>();
for (const group of TERM_GROUPS) for (const key of group.keys) GROUP_BY_KEY.set(key, group);

/** "invoiceNo", "Invoice No." and "invoice_no" all normalize to "invoice_no". */
export function normalizeKey(key: string): string {
  return foldText(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Typed groups a longer key may end with: "supplier_tax_id" is a tax id, "customer_po_number" a PO number. */
const SUFFIX_GROUPS = new Set(["tax_id", "invoice_number", "po_number", "account_number", "document_number", "delivery_note_number", "iban", "email", "phone"]);

export function groupForKey(key: string): TermGroup | undefined {
  const normalized = normalizeKey(key);
  const exact = GROUP_BY_KEY.get(normalized);
  if (exact) return exact;
  let found: { key: string; group: TermGroup } | undefined;
  for (const [groupKey, group] of GROUP_BY_KEY) {
    if (SUFFIX_GROUPS.has(group.id) && normalized.endsWith(`_${groupKey}`) && groupKey.length > (found?.key.length ?? 0)) found = { key: groupKey, group };
  }
  return found?.group;
}

/** Folded section heading → section group, for recognizing headings in any document. */
export const SECTION_HEADINGS = new Map<string, TermGroup>();
for (const group of TERM_GROUPS) {
  if (group.section) for (const term of group.terms) SECTION_HEADINGS.set(foldText(term), group);
}
