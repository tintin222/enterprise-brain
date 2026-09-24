import { describe, expect, it } from "vitest";
import { detectDocumentType, detectLanguage } from "../src/index.ts";
import { CV_TEXT, TR_INVOICE_TEXT } from "./fixtures.ts";

describe("detectLanguage", () => {
  it.each([
    ["en", "The quarterly results show that revenue grew in all regions, and the board has approved the budget for the next year."],
    ["tr", "Bu belge, şirketimizin yıllık faaliyet raporu olarak hazırlanmış ve yönetim kurulu tarafından onaylanmıştır. Raporda tüm bölgeler için gelir ve gider bilgileri yer almaktadır."],
    ["de", "Die Ergebnisse des Quartals zeigen, dass der Umsatz in allen Regionen gestiegen ist und der Vorstand das Budget für das nächste Jahr genehmigt hat."],
    ["fr", "Les résultats du trimestre montrent que le chiffre d'affaires a augmenté dans toutes les régions et que le conseil a approuvé le budget pour l'année prochaine."],
    ["es", "Los resultados del trimestre muestran que los ingresos crecieron en todas las regiones y que el consejo aprobó el presupuesto para el próximo año."],
    ["it", "I risultati del trimestre mostrano che il fatturato è cresciuto in tutte le regioni e che il consiglio ha approvato il bilancio per il prossimo anno."],
    ["nl", "De resultaten van het kwartaal laten zien dat de omzet in alle regio's is gegroeid en dat het bestuur het budget voor het komende jaar heeft goedgekeurd."],
    ["pt", "Os resultados do trimestre mostram que a receita cresceu em todas as regiões e que o conselho aprovou o orçamento para o próximo ano."],
  ])("detects %s", (language, text) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it("recognizes business documents with few function words", () => {
    expect(detectLanguage(CV_TEXT)).toBe("en");
    expect(detectLanguage(TR_INVOICE_TEXT)).toBe("tr");
    expect(detectLanguage("FATURA\nFatura No: FTR-2026-0042\nTarih: 12.09.2026\nToplam: 12.345,67 TL\nKDV\nVKN: 1234567890")).toBe("tr");
  });

  it("returns undefined for text that is too short or has no signal", () => {
    expect(detectLanguage("")).toBeUndefined();
    expect(detectLanguage("Hello")).toBeUndefined();
    expect(detectLanguage("12345 67890 %%% ---")).toBeUndefined();
    expect(detectLanguage("Xylophone quartz zephyr")).toBeUndefined();
  });
});

describe("detectDocumentType", () => {
  it.each([
    ["cv", CV_TEXT, "jane.pdf"],
    [
      "cv",
      "ÖZGEÇMİŞ\nAd Soyad: Ayşe Yılmaz\nİŞ DENEYİMİ\nABC Holding - Finans Uzmanı (2018 - 2024)\nEĞİTİM\nBoğaziçi Üniversitesi, İşletme\nYETENEKLER\nExcel, SAP",
      "belge.pdf",
    ],
    ["invoice", "Northwind Traders Ltd\nINVOICE\nInvoice Number: INV-2026-117\nBill To: Contoso GmbH\nSubtotal: 1,029.00\nVAT (20%): 205.80\nTotal Due: 1,234.80\nDue date: 2 April 2026", "doc.pdf"],
    ["invoice", TR_INVOICE_TEXT, "belge.docx"],
    ["purchase-order", "PURCHASE ORDER\nPO Number: 4500012345\nVendor: Acme Supplies\nShip To: Warehouse 3\nDelivery Date: 2026-10-01\nPlease supply the following items.", "doc.pdf"],
    ["purchase-order", "SATIN ALMA SİPARİŞİ\nSipariş No: SA-2026-15\nTedarikçi: Kaya Metal A.Ş.\nTeslim Tarihi: 01.10.2026", "doc.pdf"],
    [
      "contract",
      'SERVICE AGREEMENT\nThis Agreement is made between Acme Ltd (the "Provider") and Beta Inc (the "Client"), together the Parties.\nWHEREAS the Client wishes to engage the Provider;\nNOW, THEREFORE, the parties hereby agree as follows.\n12. Governing Law\nThis Agreement shall be governed by the laws of England.',
      "doc.pdf",
    ],
    [
      "contract",
      "HİZMET SÖZLEŞMESİ\nMadde 1 - Taraflar\nİşbu sözleşme aşağıdaki taraflar arasında imzalanmıştır.\nMadde 9 - Fesih\nMadde 12 - Uyuşmazlık\nİstanbul mahkemeleri ve icra daireleri yetkilidir.",
      "doc.pdf",
    ],
    ["delivery-note", "SEVK İRSALİYESİ\nİrsaliye No: IRS-2026-88\nSevk Tarihi: 12.09.2026\nTeslim Alan: Beta Ticaret\nAraç Plaka: 34 ABC 123", "doc.pdf"],
    ["delivery-note", "DELIVERY NOTE\nDelivery Note No: DN-778\nShip To: Contoso GmbH\nQty: 12\nReceived by: J. Smith", "doc.pdf"],
    [
      "bank-statement",
      "Account Statement\nAccount Holder: Jane Doe\nStatement Period: 01.08.2026 - 31.08.2026\nOpening Balance: 1,000.00\nClosing Balance: 1,250.00\nDate Description Debit Credit Balance",
      "doc.pdf",
    ],
    ["bank-statement", "HESAP EKSTRESİ\nHesap Sahibi: Ayşe Yılmaz\nDevreden Bakiye: 5.000,00 TL\nTarih Açıklama Borç Alacak Bakiye", "doc.pdf"],
    ["receipt", "CAFE NERO\nReceipt #1234\nFlat white 3.50\nTOTAL 3.50\nPaid by card: VISA ****1234\nThank you for your visit!", "doc.jpg"],
    [
      "id-document",
      "REPUBLIC OF TURKEY\nPASSPORT\nSurname: YILMAZ\nGiven Names: AYSE\nNationality: TUR\nDate of Birth: 05 MAR 1990\nDate of Expiry: 01 JAN 2030\nP<TURYILMAZ<<AYSE<<<<<<<<<<<<<<<<<<<<<<<<<<<",
      "scan.png",
    ],
    ["letter", "Dear Mr Smith,\nThank you for your letter regarding the renewal of our agreement terms.\nYours sincerely,\nJane Doe", "doc.docx"],
    ["letter", "Sayın İlgili,\nTalebiniz değerlendirilmiş olup sonucu bilgilerinize sunarız.\nSaygılarımızla,\nACME Yazılım A.Ş.", "doc.docx"],
    ["report", "Q3 2026 Sales Report\nExecutive Summary\nRevenue grew 12%.\nFindings\nEMEA led growth.\nRecommendations\nExpand the APAC team.", "doc.pdf"],
  ])("classifies %s", (type, text, fileName) => {
    const result = detectDocumentType(text, fileName);
    expect(result.type).toBe(type);
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.confidence).toBeLessThanOrEqual(0.99);
  });

  it("uses the file name as evidence", () => {
    const result = detectDocumentType("", "Ozgecmis_Ahmet_Kaya.pdf");
    expect(result.type).toBe("cv");
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("falls back to spreadsheet for tabular files without strong signals", () => {
    expect(detectDocumentType("Sheet: Sales (2 rows)\nRegion,Units\nEMEA,10", "sales.csv").type).toBe("spreadsheet");
    expect(detectDocumentType("Region,Units", "export", { hasSheets: true })).toMatchObject({ type: "spreadsheet", confidence: 0.9 });
    expect(detectDocumentType(TR_INVOICE_TEXT, "fatura.xlsx", { hasSheets: true }).type).toBe("invoice");
  });

  it("returns unknown without evidence", () => {
    expect(detectDocumentType("Lorem ipsum dolor sit amet.", "notes.txt")).toEqual({ type: "unknown", confidence: 0, signals: [] });
  });

  it("is more confident with a title and many signals", () => {
    const titled = detectDocumentType(`CURRICULUM VITAE\n${CV_TEXT}`, "cv.pdf");
    const plain = detectDocumentType(CV_TEXT, "document.pdf");
    expect(titled.confidence).toBeGreaterThan(plain.confidence);
    expect(titled.signals).toContain("curriculum vitae");
  });
});
