# ADR 0006: Sandbox enterprise systems behind every connector category

**Status:** accepted · 2026-09-24

## Context
Templates reference ERP, CRM, HRIS, ATS and ITSM operations. Customers connect their real systems weeks after a pilot starts, and some never expose write APIs.

## Decision
Agents bind **categories**, not products. A binding resolves to:
1. the configured instance
2. the first connected system of that category
3. a built-in **sandbox system** with realistic demo data and the same operation contracts

## Consequences
- Every template runs on day one.
- Switching to SAP or Salesforce is a configuration change.
- Sandbox data is company-scoped and persistent, so demos show real state changes (candidates created, invoices posted, 3-way-match results).
