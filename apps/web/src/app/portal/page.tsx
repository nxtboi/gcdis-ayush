'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import dynamic from 'next/dynamic';
import {
  LayoutGrid,
  Users,
  Rocket,
  FileText,
  UploadCloud,
  ShieldCheck,
  HelpCircle,
  Check,
  X,
  Menu,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import {
  fetchApi,
  downloadAuthenticatedFile,
  loadRazorpayCheckout,
  SERVICE_UNAVAILABLE_MESSAGE,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_MESSAGE,
  EMAIL_NOT_VERIFIED_MESSAGE,
  isApiErrorCode
} from '../../lib/api-client';
import { passwordPolicyError } from '../../lib/password-policy';
import EmailVerificationBanner from './_components/EmailVerificationBanner';
import { onEmailVerifiedElsewhere } from '@/lib/email-verification-sync';
import AuthView, { type RegisterFormData } from './_components/AuthView';
import OverviewTab, { type PaymentUiState } from './_components/OverviewTab';
import type { RoleFilter } from './_components/MembersTab';
import {
  EMPTY_TEAM,
  type PaidInvoice,
  type PortalTab,
  type RegistrationDocument,
  type TeamInfo,
  type TeamMember,
  ROSTER_LOCKED_MESSAGE,
  ROSTER_LOCKED_STATUSES
} from './_components/types';
import { useEventCategories } from './_components/categories';
import type { TeamSetupData } from './_components/TeamSetupPanel';
import { DURATION, EASE_OUT, tabPanelVariants } from './_components/motion';
import PortalSidebar, { type PortalNavItem } from './_components/PortalSidebar';
import { useFocusTrap } from './_components/useFocusTrap';
import { REGISTER_DRAFT_KEY, clearDraft } from './_components/wizard-draft';

// Secondary tabs and modals are loaded on demand to keep the initial portal bundle small.
const loadMembersTab = () => import('./_components/MembersTab');
const loadMissionTab = () => import('./_components/MissionTab');
const loadDocumentsTab = () => import('./_components/DocumentsTab');
const loadUploadsTab = () => import('./_components/UploadsTab');
const loadStatusTab = () => import('./_components/StatusTab');
const loadDoubtTab = () => import('./_components/DoubtTab');

const TabLoading = () => (
  <div role="status" className="flex items-center gap-2 p-6 text-xs font-semibold text-slate-500">
    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span>Loading…</span>
  </div>
);

const MembersTab = dynamic(loadMembersTab, { loading: TabLoading });
const MissionTab = dynamic(loadMissionTab, { loading: TabLoading });
const DocumentsTab = dynamic(loadDocumentsTab, { loading: TabLoading });
const UploadsTab = dynamic(loadUploadsTab, { loading: TabLoading });
const StatusTab = dynamic(loadStatusTab, { loading: TabLoading });
const DoubtTab = dynamic(loadDoubtTab, { loading: TabLoading });
const MemberCardModal = dynamic(() => import('./_components/MemberCardModal'), {
  ssr: false
});
const MemberRequestModal = dynamic(() => import('./_components/MemberRequestModal'), { ssr: false });
const MemberRemoveModal = dynamic(() => import('./_components/MemberRemoveModal'), { ssr: false });
const InvoiceModal = dynamic(() => import('./_components/InvoiceModal'), {
  ssr: false
});

// ---------------------------------------------------------------------------
// API response shapes (subset of fields used by the portal)
// ---------------------------------------------------------------------------
interface ApiUser {
  email: string;
  fullName?: string;
  phone?: string | null;
  /** GET /auth/me; absent from some responses (then re-read from /auth/me). */
  emailVerified?: boolean;
}

interface ApiTeamMember {
  id: string;
  fullName: string;
  email: string;
  mobile?: string | null;
  memberRole?: string;
  status?: string;
}

interface ApiPayment {
  id: string;
  orderId: string;
  amount: number;
  baseAmount?: number | null;
  gstAmount?: number | null;
  gstRate?: number | null;
  currency?: string;
  status: string;
  paidAt?: string | null;
}

interface ApiRegistration {
  id: string;
  registrationCode?: string;
  status: string;
  submittedAt?: string;
  payments?: ApiPayment[];
  documents?: RegistrationDocument[];
}

/** GET /teams/my-team (null until the captain has created a team). */
interface ApiTeam {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  institutionName: string;
  city: string;
  category?: { id: string; name?: string; maxTeamSize?: number } | null;
  members?: ApiTeamMember[];
  registrations?: ApiRegistration[];
}

interface CreateOrderResponse {
  keyId: string;
  amountInPaise: number;
  currency?: string;
  payment: { orderId: string };
}

interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => {
  open: () => void;
};

const NAV_ITEMS: PortalNavItem[] = [
  { id: 'overview', label: 'Overview', group: 'team', icon: LayoutGrid },
  { id: 'members', label: 'Team Members', group: 'team', icon: Users },
  { id: 'mission', label: 'Category and Rules', group: 'team', icon: Rocket },
  { id: 'status', label: 'Registration Status', group: 'registration', icon: ShieldCheck },
  { id: 'uploads', label: 'Document Uploads', group: 'registration', icon: UploadCloud },
  { id: 'documents', label: 'Documents and Invoices', group: 'registration', icon: FileText },
  { id: 'doubt', label: 'Doubt Session 2', group: 'support', icon: HelpCircle }
];

const TAB_IDS = new Set<PortalTab>(NAV_ITEMS.map((item) => item.id));

const PAID_STATUSES = new Set([
  'PAYMENT_VERIFIED',
  'DOCUMENT_REVIEW',
  'TECHNICAL_SUBMISSION',
  'TECHNICAL_INSPECTION',
  'ELIGIBILITY_REVIEW',
  'APPROVED',
  'ACCREDITED',
  'COMPETING',
  'ARENA_CLEARED',
  'COMPLETED'
]);

const FACULTY_ROLES = ['FACULTY', 'COACH', 'ADVISOR'];

/** FIDA line-up: five players per team on the field. */
const FIDA_LINE_UP = 5;

const EMPTY_REGISTRATION_FORM: RegisterFormData = {
  teamName: '',
  category: '',
  institute: '',
  city: '',
  captainName: '',
  captainEmail: '',
  captainMobile: '',
  password: '',
  confirmPassword: ''
};

const TOAST_DURATION_MS = 4000;
/** While the captain email is unverified, the dashboard re-reads the status this often (visible tab only). */
const VERIFICATION_POLL_MS = 30_000;

function mapMember(m: ApiTeamMember): TeamMember {
  const rawRole = (m.memberRole || 'TEAM_MEMBER').toUpperCase();
  return {
    id: m.id,
    name: m.fullName,
    role: rawRole.replace(/_/g, ' '),
    roleCode: rawRole,
    roleType: rawRole.includes('CAPTAIN') ? 'captain' : FACULTY_ROLES.some((r) => rawRole.includes(r)) ? 'faculty' : 'member',
    email: m.email,
    mobile: m.mobile || '',
    status: m.status || 'PENDING'
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Ensures a message reads as a complete sentence (API messages are not always punctuated). */
function asSentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function readTabFromHash(): PortalTab | null {
  if (typeof window === 'undefined') return null;
  const id = window.location.hash.replace(/^#/, '') as PortalTab;
  return TAB_IDS.has(id) ? id : null;
}

/** Preloads the on-demand tab bundles once the dashboard is idle, so switching tabs never waits on the network. */
function prefetchTabs() {
  const run = () => {
    void loadMembersTab();
    void loadMissionTab();
    void loadDocumentsTab();
    void loadUploadsTab();
    void loadStatusTab();
    void loadDoubtTab();
  };
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void) => number;
  };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run);
  else window.setTimeout(run, 1200);
}

export default function ParticipantPortalPage() {
  // Navigation & Auth State
  const [authChecked, setAuthChecked] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<PortalTab>('overview');
  const [navOpen, setNavOpen] = useState(false);
  const [showLoginToast, setShowLoginToast] = useState(false);
  const [showLogoutToast, setShowLogoutToast] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Sign-in / Register Form State
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regData, setRegData] = useState<RegisterFormData>(EMPTY_REGISTRATION_FORM);

  // Team & Member State (loaded from the API)
  const [teamInfo, setTeamInfo] = useState<TeamInfo>(EMPTY_TEAM);
  const [teamLoading, setTeamLoading] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invoice, setInvoice] = useState<PaidInvoice | null>(null);
  const [documents, setDocuments] = useState<RegistrationDocument[]>([]);
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null);
  const [teamSetupError, setTeamSetupError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  // Email verification (null while unknown). Registration submission and payment require a verified address.
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [verificationJustSent, setVerificationJustSent] = useState(false);
  /** GET /auth/email-delivery: false only on a development API without SMTP (null while unknown). */
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState<boolean | null>(null);
  const categoriesState = useEventCategories();
  const [searchMember, setSearchMember] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');

  // Modals State
  const [selectedMemberForCard, setSelectedMemberForCard] = useState<TeamMember | null>(null);
  const [selectedMemberForEdit, setSelectedMemberForEdit] = useState<TeamMember | null>(null);
  const [selectedMemberForRemove, setSelectedMemberForRemove] = useState<TeamMember | null>(null);
  /** Formal notice after a roster change (e.g. a member was removed). */
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  // Action feedback state (inline, no alert())
  const [payState, setPayState] = useState<PaymentUiState>({
    busy: false,
    error: null,
    message: null
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [passDownloading, setPassDownloading] = useState(false);
  const [invoiceDownloading, setInvoiceDownloading] = useState(false);

  /** Guards against an older team request overwriting a newer one (e.g. after sign-out and sign-in). */
  const loadSeq = useRef(0);

  const loadTeamData = useCallback(async (user: ApiUser) => {
    const seq = ++loadSeq.current;
    setDataError(null);
    setCurrentUser(user);
    setTeamLoading(true);
    const captainFields = {
      captainEmail: user.email,
      captainName: user.fullName || '',
      captainMobile: user.phone || ''
    };
    try {
      const team = await fetchApi<ApiTeam | null>('/teams/my-team');
      if (seq !== loadSeq.current) return;
      if (!team) {
        setTeamInfo({ ...EMPTY_TEAM, ...captainFields });
        setMembers([]);
        setDocuments([]);
        setInvoice(null);
        return;
      }
      // Most recent registration of the team (one per category; a team has a single category)
      const myReg = [...(team.registrations ?? [])].sort(
        (a, b) => new Date(b.submittedAt ?? 0).getTime() - new Date(a.submittedAt ?? 0).getTime()
      )[0];
      setTeamInfo({
        ...captainFields,
        name: team.name,
        teamId: myReg?.id || '',
        teamRecordId: team.id,
        teamCode: team.code,
        registrationCode: myReg?.registrationCode || '',
        categoryId: team.categoryId,
        maxTeamSize: Math.min(team.category?.maxTeamSize || 7, 7),
        category: team.category?.name || '',
        institute: team.institutionName,
        city: team.city,
        status: myReg?.status || 'NOT_SUBMITTED',
        statusDesc: myReg ? `Registration ${myReg.registrationCode || ''}`.trim() : 'Team saved; registration not yet submitted'
      });
      setMembers((team.members ?? []).map(mapMember));
      setDocuments(myReg?.documents ?? []);
      const paid = (myReg?.payments ?? []).find((p) => p.status === 'SUCCESS');
      setInvoice(
        paid
          ? {
              id: paid.id,
              orderId: paid.orderId,
              amount: paid.amount,
              baseAmount: paid.baseAmount,
              gstAmount: paid.gstAmount,
              gstRate: paid.gstRate,
              currency: paid.currency || 'INR',
              paidAt: paid.paidAt
            }
          : null
      );
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setTeamInfo((prev) => ({ ...prev, ...captainFields }));
      setDataError(
        `Your team record could not be loaded. ${asSentence(errorMessage(err, 'The request failed'))} Please refresh the page to try again.`
      );
    } finally {
      if (seq === loadSeq.current) setTeamLoading(false);
    }
  }, []);

  const reloadTeamData = useCallback(async () => {
    if (currentUser) await loadTeamData(currentUser);
  }, [currentUser, loadTeamData]);

  /**
   * Saves the team (POST /teams; the captain is added as a member by the API) and submits its registration
   * (POST /registrations). When the team already exists, only the registration is submitted.
   */
  const saveTeamAndRegistration = useCallback(async (data: TeamSetupData, existingTeamId?: string) => {
    let teamId = existingTeamId;
    let categoryId = data.categoryId;
    if (!teamId) {
      const team = await fetchApi<ApiTeam>('/teams', {
        method: 'POST',
        body: JSON.stringify({
          teamName: data.teamName.trim(),
          categoryId: data.categoryId,
          institutionName: data.institute.trim(),
          city: data.city.trim()
        })
      });
      teamId = team.id;
      categoryId = team.categoryId;
    }
    await fetchApi('/registrations', {
      method: 'POST',
      body: JSON.stringify({ teamId, categoryId })
    });
  }, []);

  const handleCompleteSetup = async (data: TeamSetupData) => {
    try {
      await saveTeamAndRegistration(data, teamInfo.teamRecordId || undefined);
      setTeamSetupError(null);
    } catch (err) {
      // Unverified email: the team is saved; the verification notice in the panel explains the next step
      if (isApiErrorCode(err, 'EMAIL_NOT_VERIFIED')) {
        setEmailVerified(false);
        return;
      }
      throw err;
    } finally {
      // Reload even after a partial failure (e.g. team saved, registration rejected) so the panel reflects it
      await reloadTeamData();
    }
  };

  const changeTab = useCallback((tab: PortalTab) => {
    setActiveTab(tab);
    setNavOpen(false);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${tab}`);
      window.scrollTo({ top: 0 });
    }
  }, []);

  /**
   * Re-reads the email verification status from GET /auth/me. Resolves true / false, or null when the
   * status could not be read (it then stays as it was; the API still enforces verification).
   */
  const refreshVerificationStatus = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await fetchApi<{ user?: ApiUser }>('/auth/me');
      if (typeof res?.user?.emailVerified === 'boolean') {
        setEmailVerified(res.user.emailVerified);
        return res.user.emailVerified;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  /**
   * The address has just been verified (code accepted): unlock registration and payment at once and
   * re-read the session state so every part of the dashboard agrees without a reload.
   */
  const handleEmailVerified = useCallback(() => {
    setEmailVerified(true);
    setVerificationJustSent(false);
    setPayState((prev) => (prev.error === EMAIL_NOT_VERIFIED_MESSAGE ? { ...prev, error: null } : prev));
    void refreshVerificationStatus();
  }, [refreshVerificationStatus]);

  /** Shared entry point after any successful sign-in or registration. */
  const enterDashboard = useCallback(
    (user: ApiUser, opts: { toast: boolean }) => {
      setAuthError(null);
      setIsLoggedIn(true);
      setLoginPassword('');
      if (typeof user.emailVerified === 'boolean') {
        setEmailVerified(user.emailVerified);
      } else {
        setEmailVerified(null);
        void refreshVerificationStatus();
      }
      setShowLogoutToast(false);
      setActiveTab(readTabFromHash() ?? 'overview');
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
      void loadTeamData(user);
      if (opts.toast) setShowLoginToast(true);
      prefetchTabs();
    },
    [loadTeamData, refreshVerificationStatus]
  );

  /** Clears every piece of signed-in state (used for sign-out and for an expired session). */
  const resetSignedInState = useCallback(() => {
    loadSeq.current += 1;
    setIsLoggedIn(false);
    setActiveTab('overview');
    setNavOpen(false);
    setTeamInfo(EMPTY_TEAM);
    setTeamLoading(false);
    setMembers([]);
    setInvoice(null);
    setDocuments([]);
    setCurrentUser(null);
    setEmailVerified(null);
    setVerificationJustSent(false);
    setTeamSetupError(null);
    setDataError(null);
    setSearchMember('');
    setRoleFilter('ALL');
    setSelectedMemberForCard(null);
    setSelectedMemberForEdit(null);
    setSelectedMemberForRemove(null);
    setMemberNotice(null);
    setSelectedMemberForRemove(null);
    setMemberNotice(null);
    setShowInviteModal(false);
    setShowInvoiceModal(false);
    setPayState({ busy: false, error: null, message: null });
    setDownloadError(null);
    setShowLoginToast(false);
    setAuthMode('login');
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      window.scrollTo({ top: 0 });
    }
  }, []);

  // Check active session on mount using real API
  useEffect(() => {
    fetchApi<{ user?: ApiUser }>('/auth/me')
      .then((res) => {
        if (res?.user) enterDashboard(res.user, { toast: false });
      })
      .catch((err: unknown) => {
        setIsLoggedIn(false);
        // A 401 simply means "not signed in"; an unreachable API deserves an explanation.
        if (err instanceof Error && err.message === SERVICE_UNAVAILABLE_MESSAGE) setAuthError(SERVICE_UNAVAILABLE_MESSAGE);
      })
      .finally(() => setAuthChecked(true));
  }, [enterDashboard]);

  // An API call failed with 401 and the session could not be refreshed: return to sign-in with an explanation.
  useEffect(() => {
    if (!isLoggedIn) return;
    const onExpired = () => {
      resetSignedInState();
      setAuthError(SESSION_EXPIRED_MESSAGE);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [isLoggedIn, resetSignedInState]);

  // While the address is unverified, keep the status fresh without a reload: the verification page announces
  // success to every open portal tab, and the status is re-read when the captain returns to this tab or window
  // and periodically while the tab is visible (e.g. when the link was opened on another device).
  useEffect(() => {
    if (!isLoggedIn || emailVerified !== false) return;
    const recheck = () => {
      if (document.visibilityState === 'visible') void refreshVerificationStatus();
    };
    const unsubscribe = onEmailVerifiedElsewhere(() => void refreshVerificationStatus());
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    const poll = window.setInterval(recheck, VERIFICATION_POLL_MS);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      window.clearInterval(poll);
    };
  }, [isLoggedIn, emailVerified, refreshVerificationStatus]);

  // Development servers without SMTP: the banner explains that verification emails are not delivered.
  useEffect(() => {
    if (!isLoggedIn || emailVerified !== false || emailDeliveryConfigured !== null) return;
    let cancelled = false;
    fetchApi<{ deliveryConfigured?: boolean }>('/auth/email-delivery')
      .then((res) => {
        if (!cancelled && typeof res?.deliveryConfigured === 'boolean') setEmailDeliveryConfigured(res.deliveryConfigured);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, emailVerified, emailDeliveryConfigured]);

  // Toast lifetimes (cleared when they are dismissed early or the component unmounts)
  useEffect(() => {
    if (!showLoginToast) return;
    const id = window.setTimeout(() => setShowLoginToast(false), TOAST_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [showLoginToast]);

  useEffect(() => {
    if (!memberNotice) return;
    const id = window.setTimeout(() => setMemberNotice(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [memberNotice]);

  useEffect(() => {
    if (!showLogoutToast) return;
    const id = window.setTimeout(() => setShowLogoutToast(false), TOAST_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [showLogoutToast]);

  // Mobile navigation drawer: focus stays inside while open, Escape closes it and focus returns to the menu button
  const drawerRef = useRef<HTMLElement>(null);
  const closeNav = useCallback(() => setNavOpen(false), []);
  useFocusTrap(drawerRef, navOpen, closeNav);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsSubmittingAuth(true);
    try {
      const res = await fetchApi<{ user?: ApiUser; requires2fa?: boolean }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: loginEmail.trim(),
          password: loginPassword
        })
      });
      if (res?.user) {
        enterDashboard(res.user, { toast: true });
      } else if (res?.requires2fa) {
        setAuthError('This account requires two-factor authentication, which is available only in the staff console.');
      } else {
        setAuthError('Sign-in could not be completed. Please try again.');
      }
    } catch (err) {
      setAuthError(asSentence(errorMessage(err, 'Sign-in could not be completed')));
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  // Sign in with Google: same success path as password login (session cookies are set by the API).
  const handleGoogleSuccess = (user: ApiUser) => {
    enterDashboard(user, { toast: true });
  };

  const handleGoogleError = (message: string) => {
    setAuthError(asSentence(message || 'Google sign-in could not be completed. Please try again'));
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (regData.password !== regData.confirmPassword) {
      setAuthError('The passwords entered do not match.');
      return;
    }
    const policyError = passwordPolicyError(regData.password, regData.captainEmail);
    if (policyError) {
      setAuthError(policyError);
      return;
    }
    setIsSubmittingAuth(true);
    let accountCreated = false;
    try {
      const registered = await fetchApi<{ user?: ApiUser; verificationEmailSent?: boolean }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: regData.captainEmail.trim(),
          password: regData.password,
          fullName: regData.captainName.trim(),
          phone: regData.captainMobile,
          organization: regData.institute.trim(),
          role: 'TEAM_CAPTAIN'
        })
      });
      accountCreated = true;
      // The registration draft has served its purpose (passwords were never part of it)
      clearDraft(REGISTER_DRAFT_KEY);
      const user: ApiUser = registered?.user ?? {
        email: regData.captainEmail.trim(),
        fullName: regData.captainName.trim(),
        phone: regData.captainMobile
      };
      // The session cookie is now set: save the team and submit its registration.
      try {
        await saveTeamAndRegistration({
          teamName: regData.teamName,
          categoryId: regData.category,
          institute: regData.institute,
          city: regData.city
        });
        setTeamSetupError(null);
      } catch (err) {
        // An unverified address is expected right after registration: the team is saved and the verification
        // banner explains that the registration can be submitted once the address has been verified.
        setTeamSetupError(
          isApiErrorCode(err, 'EMAIL_NOT_VERIFIED')
            ? null
            : `Your captain account has been created, but the team registration could not be completed. ${asSentence(
                errorMessage(err, 'The request failed')
              )} Please complete the registration using the form below.`
        );
      }
      // Say "a code has been sent" only when the API confirms delivery (otherwise the banner asks to verify and
      // the code form offers "Resend code"). Older API responses without the flag keep the previous wording.
      setVerificationJustSent(registered?.verificationEmailSent !== false);
      setRegData(EMPTY_REGISTRATION_FORM);
      enterDashboard(user, { toast: true });
    } catch (err) {
      if (!accountCreated) setAuthError(asSentence(errorMessage(err, 'Registration could not be completed')));
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleLogout = async () => {
    setIsSigningOut(true);
    try {
      await fetchApi('/auth/logout', { method: 'POST' });
    } catch {
      // Session cookies are cleared server-side when reachable; locally we always end the session.
    }
    setIsSigningOut(false);
    resetSignedInState();
    setAuthError(null);
    setShowLogoutToast(true);
  };

  const handlePayEntryFee = async () => {
    if (emailVerified === false) {
      setPayState({ busy: false, error: EMAIL_NOT_VERIFIED_MESSAGE, message: null });
      return;
    }
    setPayState({ busy: true, error: null, message: null });
    try {
      const loaded = await loadRazorpayCheckout();
      if (!loaded) {
        setPayState({
          busy: false,
          error: 'The payment window could not be loaded. Please check your connection and try again.',
          message: null
        });
        return;
      }
      const orderData = await fetchApi<CreateOrderResponse>('/payments/create-order', {
        method: 'POST',
        body: JSON.stringify({ registrationId: teamInfo.teamId })
      });
      const Razorpay = (window as unknown as { Razorpay: RazorpayConstructor }).Razorpay;
      const rzp = new Razorpay({
        key: orderData.keyId,
        amount: orderData.amountInPaise,
        currency: orderData.currency || 'INR',
        name: 'GCDIS Championship 2026',
        description: `Entry fee: ${teamInfo.category}`,
        order_id: orderData.payment.orderId,
        handler: async (response: RazorpayHandlerResponse) => {
          try {
            await fetchApi('/payments/verify-signature', {
              method: 'POST',
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature
              })
            });
            setPayState({
              busy: false,
              error: null,
              message: 'Payment received and verified. Your invoice is now available under Documents and Invoices.'
            });
            // Reload so the status, invoice and registration timeline reflect the verified payment.
            await reloadTeamData();
          } catch (err) {
            setPayState({
              busy: false,
              error: `The payment could not be verified. ${asSentence(errorMessage(err, 'Unknown error'))} If your account has been debited, please contact the GCDIS Secretariat.`,
              message: null
            });
          }
        },
        modal: {
          ondismiss: () => setPayState((prev) => ({ ...prev, busy: false }))
        },
        prefill: {
          name: teamInfo.captainName,
          email: teamInfo.captainEmail,
          contact: teamInfo.captainMobile
        },
        theme: { color: '#15803D' }
      });
      rzp.open();
    } catch (err) {
      if (isApiErrorCode(err, 'EMAIL_NOT_VERIFIED')) setEmailVerified(false);
      setPayState({
        busy: false,
        error: asSentence(errorMessage(err, 'The payment could not be initiated')),
        message: null
      });
    }
  };

  const handleDownloadInvoice = async () => {
    if (!invoice) return;
    setDownloadError(null);
    setInvoiceDownloading(true);
    try {
      await downloadAuthenticatedFile(
        `/payments/invoice/${encodeURIComponent(invoice.id)}/pdf`,
        `invoice-${invoice.orderId}.pdf`
      );
    } catch (err) {
      setDownloadError(asSentence(errorMessage(err, 'The invoice could not be downloaded')));
    } finally {
      setInvoiceDownloading(false);
    }
  };

  const handleDownloadPass = async (member: TeamMember) => {
    setDownloadError(null);
    setPassDownloading(true);
    try {
      await downloadAuthenticatedFile(
        `/certificates/pass/${encodeURIComponent(member.id)}/pdf`,
        `pass-${member.name.replace(/[^a-z0-9-]+/gi, '_')}.pdf`
      );
    } catch (err) {
      setDownloadError(asSentence(errorMessage(err, 'The accreditation pass could not be downloaded')));
    } finally {
      setPassDownloading(false);
    }
  };

  // Filtered members list
  const filteredMembers = members.filter((m) => {
    const q = searchMember.trim().toLowerCase();
    const matchesSearch =
      !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || m.role.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (roleFilter === 'CAPTAIN') return m.roleType === 'captain';
    if (roleFilter === 'FACULTY') return m.roleType === 'faculty';
    if (roleFilter === 'MEMBER') return m.roleType === 'member';
    return true;
  });

  // Profile completion derived from real data instead of a hardcoded percentage
  const completionChecks = [
    Boolean(teamInfo.teamRecordId),
    Boolean(teamInfo.teamId),
    Boolean(teamInfo.institute && teamInfo.city),
    Boolean(teamInfo.captainMobile),
    members.length >= FIDA_LINE_UP,
    documents.length > 0
  ];
  const profileCompletion = Math.round((completionChecks.filter(Boolean).length / completionChecks.length) * 100);
  const isPaid = Boolean(invoice) || PAID_STATUSES.has(teamInfo.status);
  const coachCount = members.filter((m) => m.roleCode === 'COACH').length;

  // -------------------------------------------------------------
  // VIEW: SESSION CHECK IN PROGRESS
  // -------------------------------------------------------------
  if (!authChecked) {
    return (
      <div
        className="min-h-screen bg-topography flex items-center justify-center gap-2 text-xs font-mono text-slate-500"
        role="status"
      >
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>Verifying your session…</span>
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: REGISTER & LOGIN PORTAL (WHEN NOT LOGGED IN)
  // -------------------------------------------------------------
  if (!isLoggedIn) {
    return (
      <AuthView
        authMode={authMode}
        setAuthMode={(mode) => {
          setAuthMode(mode);
          setAuthError(null);
        }}
        loginEmail={loginEmail}
        setLoginEmail={setLoginEmail}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        regData={regData}
        setRegData={setRegData}
        handleLoginSubmit={handleLoginSubmit}
        handleRegisterSubmit={handleRegisterSubmit}
        showLogoutToast={showLogoutToast}
        authError={authError}
        isSubmitting={isSubmittingAuth}
        onGoogleSuccess={handleGoogleSuccess}
        onGoogleError={handleGoogleError}
        categoriesState={categoriesState}
      />
    );
  }

  const activeTitle = NAV_ITEMS.find((item) => item.id === activeTab)?.label ?? '';
  const avatarInitial = (teamInfo.captainName || teamInfo.captainEmail || '?').charAt(0).toUpperCase();

  const sidebar = (variant: 'desktop' | 'drawer') => (
    <PortalSidebar
      variant={variant}
      items={NAV_ITEMS}
      activeTab={activeTab}
      onNavigate={changeTab}
      teamInfo={teamInfo}
      emailVerified={emailVerified}
      memberCount={members.length}
      isPaid={isPaid}
      onSignOut={handleLogout}
      isSigningOut={isSigningOut}
      onClose={closeNav}
    />
  );

  // -------------------------------------------------------------
  // VIEW: AUTHENTICATED TEAM DASHBOARD
  // -------------------------------------------------------------
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-topography font-sans text-slate-900 lg:flex">
        {/* 1. LEFT DARK SIDEBAR (desktop) */}
        <aside className="hidden lg:block w-64 bg-[#111625] text-slate-300 shrink-0 border-r-2 border-bento-ink select-none">
          <div className="sticky top-0 h-screen overflow-y-auto">{sidebar('desktop')}</div>
        </aside>

        {/* 1b. NAVIGATION DRAWER (mobile and tablet) */}
        <AnimatePresence>
          {navOpen && (
            <motion.div
              key="portal-nav-drawer"
              className="fixed inset-0 z-40 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast }}
            >
              <div
                className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
                onClick={() => setNavOpen(false)}
                aria-hidden="true"
              />
              <motion.aside
                ref={drawerRef}
                id="portal-nav-drawer"
                role="dialog"
                aria-modal="true"
                aria-label="Team dashboard navigation"
                className="absolute inset-y-0 left-0 w-[19rem] max-w-[86vw] overflow-y-auto border-r-2 border-bento-ink bg-[#111625] text-slate-300 shadow-[6px_0_0_#C6F432] select-none"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: DURATION.base, ease: EASE_OUT }}
              >
                {sidebar('drawer')}
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2. MAIN RIGHT CONTENT AREA */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="px-4 sm:px-8 py-4 sm:py-5 border-b border-slate-200/80 bg-white/70 backdrop-blur-md flex items-center justify-between gap-3 sticky top-0 z-20">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
                aria-expanded={navOpen}
                aria-controls="portal-nav-drawer"
                className="lg:hidden -ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-[2.5px] border-bento-ink bg-bento-lime text-bento-ink shadow-[3px_3px_0_#111] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none motion-reduce:transition-none focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-ink"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest font-mono">Team Portal</div>
                <motion.h1
                  key={activeTitle}
                  className="truncate text-lg sm:text-xl font-black text-slate-900 tracking-tight"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: DURATION.fast, ease: EASE_OUT }}
                >
                  {activeTitle}
                </motion.h1>
              </div>
            </div>

            {/* Profile Avatar & Email Pill */}
            <div
              className="flex min-w-0 items-center gap-2.5 bg-slate-50 border border-slate-200 px-1.5 sm:px-3 py-1.5 rounded-full shadow-sm"
              title={teamInfo.captainEmail}
            >
              <div
                className="w-6 h-6 shrink-0 rounded-full bg-[#22C55E] text-slate-950 font-black text-xs flex items-center justify-center font-mono"
                aria-hidden="true"
              >
                {avatarInitial}
              </div>
              <span className="hidden sm:block truncate max-w-[16rem] text-xs font-bold text-slate-700 font-mono">
                <span className="sr-only">Signed in as </span>
                {teamInfo.captainEmail}
              </span>
              <span className="sr-only sm:hidden">Signed in as {teamInfo.captainEmail}</span>
            </div>
          </header>

          {/* TAB WORK AREA */}
          <main className="p-4 sm:p-8 space-y-6 flex-1">
            {emailVerified === false && (
              <EmailVerificationBanner
                email={currentUser?.email || teamInfo.captainEmail}
                justRegistered={verificationJustSent}
                onVerified={handleEmailVerified}
                deliveryConfigured={emailDeliveryConfigured}
              />
            )}
            <AnimatePresence initial={false}>
              {dataError && (
                <motion.div
                  key="data-error"
                  role="alert"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: DURATION.fast }}
                  className="max-w-6xl p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs font-semibold"
                >
                  {dataError}
                </motion.div>
              )}
            </AnimatePresence>
            {/*
              Enter-only transition: the outgoing panel is replaced immediately rather than awaiting an exit
              animation, so switching tabs never blocks on animation frames (e.g. in a throttled background tab)
              and rapid switching cannot queue panels.
            */}
            <motion.div key={activeTab} variants={tabPanelVariants} initial="initial" animate="animate">
              {activeTab === 'overview' && (
                <OverviewTab
                  teamInfo={teamInfo}
                  loading={teamLoading && !teamInfo.teamRecordId}
                  memberCount={members.length}
                  documentCount={documents.length}
                  profileCompletion={profileCompletion}
                  isPaid={isPaid}
                  payState={payState}
                  onPay={handlePayEntryFee}
                  onGoToUploads={() => changeTab('uploads')}
                  onGoToMembers={() => changeTab('members')}
                  categoriesState={categoriesState}
                  teamSetupError={teamSetupError}
                  onCompleteSetup={handleCompleteSetup}
                  verificationGate={
                    emailVerified === false
                      ? {
                          email: currentUser?.email || teamInfo.captainEmail,
                          deliveryConfigured: emailDeliveryConfigured,
                          onVerified: handleEmailVerified
                        }
                      : null
                  }
                />
              )}
              {activeTab === 'members' && (
                <MembersTab
                  members={filteredMembers}
                  totalCount={members.length}
                  loading={teamLoading && members.length === 0}
                  loadError={dataError}
                  searchMember={searchMember}
                  setSearchMember={setSearchMember}
                  roleFilter={roleFilter}
                  setRoleFilter={setRoleFilter}
                  onInvite={() => setShowInviteModal(true)}
                  onViewCard={(member) => {
                    setDownloadError(null);
                    setSelectedMemberForCard(member);
                  }}
                  onEdit={setSelectedMemberForEdit}
                  onRemove={setSelectedMemberForRemove}
                  removeLockedReason={ROSTER_LOCKED_STATUSES.has(teamInfo.status) ? ROSTER_LOCKED_MESSAGE : null}
                  onGoToOverview={() => changeTab('overview')}
                  canManage={Boolean(teamInfo.teamRecordId)}
                  maxTeamSize={teamInfo.maxTeamSize}
                />
              )}
              {activeTab === 'mission' && <MissionTab teamInfo={teamInfo} />}
              {activeTab === 'documents' && (
                <DocumentsTab
                  teamInfo={teamInfo}
                  invoice={invoice}
                  downloadError={showInvoiceModal ? null : downloadError}
                  isDownloading={invoiceDownloading}
                  onViewInvoice={() => {
                    setDownloadError(null);
                    setShowInvoiceModal(true);
                  }}
                  onDownloadInvoice={handleDownloadInvoice}
                  documents={documents}
                  onGoToUploads={() => changeTab('uploads')}
                />
              )}
              {activeTab === 'uploads' && (
                <UploadsTab
                  teamInfo={teamInfo}
                  documents={documents}
                  onUploaded={reloadTeamData}
                  onGoToOverview={() => changeTab('overview')}
                />
              )}
              {activeTab === 'status' && <StatusTab teamInfo={teamInfo} documents={documents} isPaid={isPaid} />}
              {activeTab === 'doubt' && <DoubtTab teamInfo={teamInfo} />}
            </motion.div>
          </main>
        </div>

        {/* FLOATING LOGIN TOAST */}
        <AnimatePresence>
          {showLoginToast && (
            <motion.div
              role="status"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: DURATION.base, ease: EASE_OUT }}
              className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 z-50 bg-[#111625] text-white border border-slate-700/80 rounded-2xl px-5 py-3.5 shadow-2xl flex items-center gap-3 text-xs font-bold"
            >
              <div className="w-5 h-5 shrink-0 rounded-full bg-[#22C55E]/20 text-[#22C55E] flex items-center justify-center">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              </div>
              <span className="flex-1">You have signed in successfully.</span>
              <button
                type="button"
                onClick={() => setShowLoginToast(false)}
                aria-label="Dismiss notification"
                className="text-slate-400 hover:text-white ml-2"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ROSTER CHANGE NOTICE */}
        <AnimatePresence>
          {memberNotice && (
            <motion.div
              key="member-notice"
              role="status"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: DURATION.base, ease: EASE_OUT }}
              className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 z-50 bg-[#111625] text-white border border-slate-700/80 rounded-2xl px-5 py-3.5 shadow-2xl flex items-center gap-3 text-xs font-bold"
            >
              <div className="w-5 h-5 shrink-0 rounded-full bg-[#22C55E]/20 text-[#22C55E] flex items-center justify-center">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              </div>
              <span className="flex-1">{memberNotice}</span>
              <button
                type="button"
                onClick={() => setMemberNotice(null)}
                aria-label="Dismiss notification"
                className="text-slate-400 hover:text-white ml-2"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* MODALS (loaded on demand) */}
        <AnimatePresence>
          {selectedMemberForCard && (
            <MemberCardModal
              key="member-card"
              member={selectedMemberForCard}
              teamInfo={teamInfo}
              onClose={() => setSelectedMemberForCard(null)}
              onDownloadPass={handleDownloadPass}
              downloadError={downloadError}
              isDownloading={passDownloading}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showInviteModal && (
            <MemberRequestModal
              key="invite-member"
              mode="invite"
              teamInfo={teamInfo}
              memberCount={members.length}
              coachCount={coachCount}
              onSaved={() => void reloadTeamData()}
              onClose={() => setShowInviteModal(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {selectedMemberForEdit && (
            <MemberRequestModal
              key="edit-member"
              mode="edit"
              teamInfo={teamInfo}
              initial={{
                id: selectedMemberForEdit.id,
                name: selectedMemberForEdit.name,
                role: selectedMemberForEdit.roleCode,
                email: selectedMemberForEdit.email,
                mobile: selectedMemberForEdit.mobile
              }}
              memberCount={members.length}
              coachCount={coachCount}
              onSaved={() => void reloadTeamData()}
              onClose={() => setSelectedMemberForEdit(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {selectedMemberForRemove && (
            <MemberRemoveModal
              key="remove-member"
              teamInfo={teamInfo}
              member={selectedMemberForRemove}
              onRemoved={(removed) => {
                // Update the roster (and its count) at once, then reload it from the API
                setMembers((current) => current.filter((m) => m.id !== removed.id));
                setMemberNotice(`${removed.name} has been removed from the team.`);
                void reloadTeamData();
                // The Remove button that opened the dialog no longer exists: move focus to the roster heading
                // once the dialog has closed, so keyboard and screen-reader users keep their place
                window.setTimeout(() => document.getElementById('team-members-heading')?.focus(), 400);
              }}
              onClose={() => setSelectedMemberForRemove(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showInvoiceModal && invoice && (
            <InvoiceModal
              key="invoice"
              teamInfo={teamInfo}
              invoice={invoice}
              onClose={() => setShowInvoiceModal(false)}
              onDownload={handleDownloadInvoice}
              downloadError={downloadError}
              isDownloading={invoiceDownloading}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
