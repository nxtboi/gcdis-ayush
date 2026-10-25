/**
 * Client-side validation of the team registration wizard. It mirrors (and never relaxes or tightens) the
 * rules the API already enforces, so captains see a friendly message before a request is sent:
 *
 * - POST /teams (CreateTeamDto): teamName, institutionName and city are required strings of at most 80, 160
 *   and 80 characters; categoryId is required.
 * - POST /auth/register (RegisterUserSchema + password policy): a valid email address, a full name of at least
 *   two characters and a password that satisfies the account password policy. The portal also asks for a
 *   10-digit captain mobile number (the existing form pattern).
 *
 * Pure logic (no React or path aliases) so it can be unit-tested.
 */
import { passwordPolicyError } from '../../../lib/password-policy';

export const TEAM_NAME_MAX = 80;
export const INSTITUTE_MAX = 160;
export const CITY_MAX = 80;
export const CAPTAIN_NAME_MIN = 2;
export const CAPTAIN_NAME_MAX = 120;
export const EMAIL_MAX = 254;
export const MOBILE_PATTERN = /^[0-9]{10}$/;
/** Pragmatic email check (the API applies the full validation). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

export interface TeamDetailsValues {
  teamName: string;
  institute: string;
  city: string;
}

function requiredText(value: string, label: string, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `Please enter the ${label}.`;
  if (trimmed.length > max) return `The ${label} must not exceed ${max} characters (currently ${trimmed.length}).`;
  return undefined;
}

export function validateTeamDetails(values: TeamDetailsValues): FieldErrors<keyof TeamDetailsValues> {
  const errors: FieldErrors<keyof TeamDetailsValues> = {};
  const teamName = requiredText(values.teamName, 'team display name', TEAM_NAME_MAX);
  if (teamName) errors.teamName = teamName;
  const institute = requiredText(values.institute, 'institution or college name', INSTITUTE_MAX);
  if (institute) errors.institute = institute;
  const city = requiredText(values.city, 'city and state', CITY_MAX);
  if (city) errors.city = city;
  return errors;
}

export function validateCategory(categoryId: string): FieldErrors<'categoryId'> {
  return categoryId ? {} : { categoryId: 'Please choose the competition category your team will enter.' };
}

export interface CaptainValues {
  captainName: string;
  captainEmail: string;
  captainMobile: string;
  password: string;
  confirmPassword: string;
}

export function validateCaptain(values: CaptainValues): FieldErrors<keyof CaptainValues> {
  const errors: FieldErrors<keyof CaptainValues> = {};
  const name = values.captainName.trim();
  if (!name) errors.captainName = "Please enter the captain's full name.";
  else if (name.length < CAPTAIN_NAME_MIN) errors.captainName = `The full name must be at least ${CAPTAIN_NAME_MIN} characters.`;
  else if (name.length > CAPTAIN_NAME_MAX) errors.captainName = `The full name must not exceed ${CAPTAIN_NAME_MAX} characters.`;

  if (!values.captainMobile) errors.captainMobile = 'Please enter the captain mobile number.';
  else if (!MOBILE_PATTERN.test(values.captainMobile)) errors.captainMobile = 'Please enter a 10-digit mobile number, without +91 or spaces.';

  const email = values.captainEmail.trim();
  if (!email) errors.captainEmail = 'Please enter the captain email address.';
  else if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) errors.captainEmail = 'Please enter a valid email address, for example captain@institution.ac.in.';

  if (!values.password) errors.password = 'Please choose a password.';
  else {
    const policy = passwordPolicyError(values.password, email);
    if (policy) errors.password = policy;
  }
  if (!values.confirmPassword) errors.confirmPassword = 'Please enter the password again to confirm it.';
  else if (values.password !== values.confirmPassword) errors.confirmPassword = 'The passwords entered do not match.';
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/** Wizard step ids, in order. */
export const WIZARD_STEPS = [
  { id: 'team', label: 'Team details', short: 'Team' },
  { id: 'captain', label: 'Captain & members', short: 'Captain' },
  { id: 'category', label: 'Category', short: 'Category' },
  { id: 'review', label: 'Review & submit', short: 'Review' }
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** Fields of a registration draft that may be kept in localStorage: never passwords or other secrets. */
export const DRAFT_SAFE_FIELDS = ['teamName', 'institute', 'city', 'category', 'categoryId', 'captainName', 'captainEmail', 'captainMobile'] as const;

/** Copies only the draft-safe string fields of `values`. */
export function toSafeDraft(values: Record<string, unknown>): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const key of DRAFT_SAFE_FIELDS) {
    const value = values[key];
    if (typeof value === 'string' && value) draft[key] = value.slice(0, 400);
  }
  return draft;
}

/** True when a draft has anything worth restoring. */
export function draftHasContent(draft: Record<string, string> | null | undefined): boolean {
  return Boolean(draft && Object.values(draft).some((v) => v.trim()));
}
