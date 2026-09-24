export interface DemoEmail {
  topic: "support" | "it";
  from: string;
  fromName: string;
  subject: string;
  body: string;
}

export const DEMO_EMAILS: DemoEmail[] = [
  {
    topic: "support",
    from: "a.yilmaz@yilmazinsaat.com.tr",
    fromName: "Ahmet Yılmaz",
    subject: "Siparişim hâlâ gelmedi - SO-80017",
    body: "Merhaba,\n\n3 hafta önce verdiğim SO-80017 numaralı sipariş hâlâ elime ulaşmadı. Şantiyede işler durdu, acil bilgi rica ediyorum. Ne zaman teslim edilecek?\n\nAhmet Yılmaz\nYılmaz İnşaat",
  },
  {
    topic: "support",
    from: "procurement@northwind-traders.co.uk",
    fromName: "Sarah Miller",
    subject: "Return request for damaged valves (order SO-80011)",
    body: "Hello,\n\nFour of the 20 ball valves delivered with order SO-80011 arrived with cracked housings. Photos attached in our portal. We would like replacements or a refund for the damaged units.\n\nKind regards,\nSarah Miller\nNorthwind Traders",
  },
  {
    topic: "support",
    from: "muhasebe@karadenizenerji.com.tr",
    fromName: "Elif Demir",
    subject: "Question about invoice FTR-2026-1187",
    body: "Hi,\n\nInvoice FTR-2026-1187 shows 60 days payment terms but our contract says 90 days. Could you please check and send a corrected invoice?\n\nThanks,\nElif Demir\nKaradeniz Enerji - Accounting",
  },
  {
    topic: "it",
    from: "zeynep.aydin@acme.com.tr",
    fromName: "Zeynep Aydın",
    subject: "VPN access needed for remote work",
    body: "Hi IT,\n\nI start working remotely two days a week from next Monday. Could you please give me VPN access? My manager Can Şahin already approved remote work.\n\nThanks,\nZeynep (Finance)",
  },
  {
    topic: "it",
    from: "burak.celik@acme.com.tr",
    fromName: "Burak Çelik",
    subject: "Laptop very slow + Outlook crashing",
    body: "Merhaba,\n\nLaptopum son iki gündür çok yavaş ve Outlook sürekli kapanıyor. Asset etiketi ACM-LT-0142. Yardımcı olabilir misiniz?\n\nBurak Çelik - Satış",
  },
];
