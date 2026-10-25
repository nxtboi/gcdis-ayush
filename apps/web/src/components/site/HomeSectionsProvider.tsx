'use client';

import React, { createContext, useContext } from 'react';

const HiddenSectionsContext = createContext<readonly string[]>([]);

/**
 * Anchors of home page sections hidden from the staff console (for example `news`), provided by the root
 * layout so the navbar and footers on every page can drop links to them.
 */
export function HomeSectionsProvider({ hiddenAnchors, children }: { hiddenAnchors: readonly string[]; children: React.ReactNode }) {
  return <HiddenSectionsContext.Provider value={hiddenAnchors}>{children}</HiddenSectionsContext.Provider>;
}

/** Anchors of hidden home page sections (empty when every section is shown). */
export function useHiddenHomeSections(): readonly string[] {
  return useContext(HiddenSectionsContext);
}
