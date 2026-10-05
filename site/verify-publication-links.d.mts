import type { Page } from "@playwright/test";

export interface PublicationLinkGroup {
  name: string;
  selector: string;
  required?: boolean;
  mutedRest?: boolean;
}

export const publicationLinkGroups: readonly PublicationLinkGroup[];
export function verifyPublicationLinks(page: Page, groups?: readonly PublicationLinkGroup[]): Promise<unknown[]>;
