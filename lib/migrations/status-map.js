"use strict";

// Old status values to the shared status list (content/statuses.json), for
// importing data kept in the tracker this project grew out of. Each section
// had its own list; they all map onto the same 22 subtypes now.

const MK = {
  // "todo" depends on whether the target had a date; see mapStatus.
  todo: null,
  done: "completed",
  rejected: "rejected",
  live: "completed",
  submitted: "completed",
  pending: "scheduled",
  parked: "scheduled",
  drafting: "scheduled",
};

const PO = {
  "Discovered": "new",
  "Eligibility Review": "researching",
  "Qualified": "scheduled",
  "Prioritized": "scheduled",
  "Renewal / Reapply": "later",
  "Reopen Monitoring": "later",
  "Preparing": "preparing",
  "Drafting": "preparing",
  "Internal Review": "preparing",
  "Ready to Submit": "preparing",
  "Submitted": "submitted",
  "Confirmation Received": "submitted",
  "Shortlisted": "interview_pitch",
  "Interview / Pitch": "interview_pitch",
  "Due Diligence": "due_diligence",
  "Waitlisted": "on_hold",
  "Accepted": "won",
  "Onboarding": "active",
  "Active": "active",
  "Reporting": "active",
  "Completed": "completed",
  "Ineligible": "not_eligible",
  "Not Pursuing": "not_pursuing",
  "Withdrawn": "not_pursuing",
  "Cancelled": "not_pursuing",
  "Archived": "not_pursuing",
  "Skipped for now": "later",
  "Future Reserve": "later",
  "Rejected": "rejected",
  "Deadline Missed / Expired": "expired",
};

const FU = {
  "Identified": "new",
  "Qualified": "scheduled",
  "Contacted": "in_contact",
  "Discovery": "in_contact",
  "Scope Defined": "preparing",
  "Applied / Materials Sent": "submitted",
  "Applied": "submitted",
  "Proposal Sent": "submitted",
  "Due Diligence": "due_diligence",
  "Terms Offered": "negotiating",
  "Negotiation": "negotiating",
  "Committed / Awarded": "won",
  "Committed": "won",
  "Awarded": "won",
  "Closed Won": "won",
  "Partially Received": "active",
  "Fully Received": "received",
  "On Hold": "on_hold",
  "Withdrawn": "not_pursuing",
  "Declined": "rejected",
  "Closed Lost": "rejected",
};

// Company setup steps, compliance items and their date entries.
const COMPANY = {
  not_started: "scheduled",
  de_depus: "scheduled",
  in_progress: "preparing",
  in_lucru: "preparing",
  submitted: "submitted",
  // Waiting for the authority.
  revision: "submitted",
  completed: "completed",
  depus: "completed",
  // Overdue is worked out from the date now, not stored.
  intarziat: "scheduled",
  expira: "expired",
  rejected: "rejected",
  na: "not_eligible",
};

// Expenses keep their own two-value list.
const EXPENSE = {
  platit: "paid",
  neplatit: "unpaid",
};

const MAPS = { mk: MK, po: PO, fu: FU, company: COMPANY, expense: EXPENSE };

// The new status for an old one, or null when the old value is unknown (the
// import then keeps it and shows it as "Unmapped").
function mapStatus(section, oldStatus, record = {}) {
  const map = MAPS[section];
  if (!map) throw new RangeError(`Unknown section for status mapping: ${section}`);
  if (!Object.prototype.hasOwnProperty.call(map, oldStatus)) return null;
  if (section === "mk" && oldStatus === "todo") return record.date ? "scheduled" : "new";
  return map[oldStatus];
}

module.exports = { MAPS, mapStatus };
