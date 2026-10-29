# Company

The Company tab (COMP on badges) tracks the legal entity behind the startup: how it was set up, what it has to file and when, what it spends, and a short summary to paste into forms. It is not legal or tax advice; every page says so.

![The Company Setup tab: completed steps, their authorities, dates, notes and official sources, and the next steps](assets/screenshot-company.png)

*Setup for the demo startup's UK Ltd: each step names its authority, dates and official sources.*

## Templates

Pick the country and legal form in **Profile**. The picker covers 199 countries and territories, from Afghanistan to Zimbabwe, including Hong Kong, Macau, Kosovo, Palestine and Taiwan. For each country it offers the major forms a founder is likely to use:

- the private limited liability company, the usual startup vehicle;
- the public limited or joint-stock company;
- a partnership or LLP where that is a common choice.

The first templates, for the United States, China, Germany, Japan, India, the United Kingdom, France, Italy, Canada, Brazil and Romania, keep their detailed steps, conditions and due rules. The newer country templates have the same shape: setup steps, recurring obligations, profile fields, people roles, expense categories and a document template. Where the official pages do not settle a fee or a date, they say **check locally** instead of guessing.

The picker groups forms by country; the country of the template you already picked comes first, and Generic stays last. Each template brings setup steps, recurring obligations, the fields a company of that form has, the roles of its people and the expense categories.

The countries are the ISO 3166-1 entries in the country picker, with Kosovo, Palestine and Taiwan added, plus Hong Kong and Macau, whose company law differs from mainland China. The picker's note links to the IMF data for the ten largest economies by nominal GDP in 2025.

**Generic** covers any other country or form. You name the legal form and the country, and add your own steps and obligations.

### Sources

Every template step and obligation names the official page it comes from (a government, a registry or the law itself) and the date it was checked. Where the official pages did not settle a point, or could not be reached when the template was written, the entry says **check locally**: ask the authority or an accountant. Amounts carry the date they were seen on.

Due dates follow the rule on the official page. When a date falls on a weekend or a holiday, most authorities move it to the next working day; the tracker shows the nominal date.

### Template updates

A new version of a template changes only its text. Your statuses, dates, notes and history stay, because they are stored against the template's step and obligation ids.

## Profile

- **Incorporated.** Until you tick it, only Profile and Setup show. Then come the incorporation date (some deadlines count from it), the financial year end (MM-DD; Indian companies use 03-31) and the monthly budget.
- **What applies to the company.** Conditions such as "VAT registered, quarterly returns" or "Has employees". Obligations that depend on one show only when it is ticked.
- **Region.** Templates where rules differ by state or province (US LLC, Canada, Brazil) ask for it.
- **Fields.** The template's own fields, such as the registration number or the tax code.
- **People.** As many as you need, each with a role, ownership and the date they started. The total ownership is shown.
- **Bank accounts.** A label, a currency and the IBAN or account number.

The Romanian template is in English and Romanian. The EN/RO switch in the header changes the template text and the document, and is remembered.

Picking a template also fills in the entity type in Settings > Startup profile, which the prompts use.

## Sensitive values

National ID numbers, bank account numbers and any field a template marks as sensitive:

- are stored on this computer and shown masked (`•••• 1234`) until you choose **Show and edit**;
- are read and written only through their own route, by the tracker page or with the master token, never by an agent token;
- are not part of the startup's state, its changes feed, its history, the prompts or the document;
- are left out of exports unless you tick "Include sensitive company values".

## Setup

The template's steps in order, each with the authority, a typical cost where an official page gives one, the steps it follows, its sources and its status. **Edit** opens the step in the same kind of window as a target: status, due date, done date, notes and the files linked to it. **Add a step** adds your own.

## Obligations

The deadlines of the next twelve months (and the last three, so a missed one still shows), each with its status. Overdue and "due soon" (14 days) are worked out from today's date; nothing is stored. Obligations without a fixed date (on an event, or "check locally") ask you to add the date when you know it.

Below the deadlines is the list of obligations, with the rule in words, the conditions, the sources and whether it applies. You can mark a template obligation as not applying to you, or add your own (monthly by a day, quarterly, yearly on a date, or without a fixed date).

The header's **need attention** badge, also shown on the Company tab, counts deadlines and dated steps that are overdue or due within two weeks.

## Expenses

Date, description, category, amount, currency, how often it repeats and whether it is paid, with files linked like a step. The header compares this month's spending in the startup's currency (Settings > Startup profile) with the monthly budget.

## Document

A Markdown summary of the company from the profile, ready to copy. Empty fields read "(not set)". Sensitive values never appear in it.

## Calendar and search

Dated steps and deadlines appear in the calendar under Company, with their real status, and in the search. Opening one goes to the Company tab and opens its window.
