/** Recognising the business systems people mention ("our ATS", "SAP", "İK sistemi"). */

/** System category of a free-text description, e.g. "our applicant tracking system" -> "ats". */
export function guessSystemCategory(description: string): string | undefined {
  const d = description.toLocaleLowerCase("tr");
  if (/\bats\b|applicant|kariyer\.?net|greenhouse|\blever\b|smartrecruiters|recruit|aday takip|işe alım sistemi/.test(d)) return "ats";
  if (/successfactors|workday|\bhris\b|\bhr system|\bik sistemi|insan kaynakları sistemi|bamboohr|personio|peoplesoft/.test(d)) return "hris";
  if (/salesforce|hubspot|\bcrm\b|dynamics 365 sales|\bzoho\b/.test(d)) return "crm";
  if (/servicenow|\bjira\b|\bitsm\b|helpdesk|help desk|service desk/.test(d)) return "itsm";
  if (/\bsap\b|s\/4|\berp\b|netsis|\blogo (tiger|go|j-guar)|dynamics|netsuite|\boracle\b|muhasebe|accounting/.test(d)) return "erp";
  if (/sharepoint|onedrive|google drive|shared folder|network drive|ortak klasör|paylaşılan klasör/.test(d)) return "dms";
  return undefined;
}

const KNOWN_SYSTEMS: [RegExp, string][] = [
  [/successfactors/i, "SAP SuccessFactors"],
  [/s\/?4 ?hana/i, "SAP S/4HANA"],
  [/\bsap\b/i, "SAP"],
  [/workday/i, "Workday"],
  [/salesforce/i, "Salesforce"],
  [/hubspot/i, "HubSpot"],
  [/dynamics/i, "Microsoft Dynamics 365"],
  [/greenhouse/i, "Greenhouse"],
  [/kariyer\.?net/i, "Kariyer.net"],
  [/servicenow/i, "ServiceNow"],
  [/\bjira\b/i, "Jira"],
  [/netsuite/i, "NetSuite"],
  [/netsis/i, "Netsis"],
  [/sharepoint/i, "SharePoint"],
];

const CATEGORY_NAMES: Record<string, { en: string; tr: string }> = {
  ats: { en: "our applicant tracking system (ATS)", tr: "aday takip sistemimiz (ATS)" },
  hris: { en: "our HR system", tr: "İK sistemimiz" },
  crm: { en: "our CRM", tr: "CRM sistemimiz" },
  itsm: { en: "our IT service desk", tr: "BT hizmet masamız" },
  erp: { en: "our ERP", tr: "ERP sistemimiz" },
  dms: { en: "our document library", tr: "doküman kütüphanemiz" },
};

/**
 * A short name for the system a requester described ("Shortlisted candidates should be created
 * in our ATS." -> "our applicant tracking system (ATS)"); undefined when none is recognisable.
 */
export function describeSystem(answer: string | undefined, language = "en"): string | undefined {
  if (!answer?.trim()) return undefined;
  const known = KNOWN_SYSTEMS.find(([pattern]) => pattern.test(answer));
  if (known) return known[1];
  const category = guessSystemCategory(answer);
  const names = category ? CATEGORY_NAMES[category] : undefined;
  return names ? (language.startsWith("tr") ? names.tr : names.en) : undefined;
}
