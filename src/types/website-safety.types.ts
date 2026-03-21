export type SafetyVerdict =
  | "high-risk"
  | "suspicious"
  | "use-caution"
  | "looks-trustworthy";

export interface WebsiteSafetyResponse {
  inputUrl: string;
  normalizedUrl: string;
  hostname: string;
  registrableDomain?: string;
  finalUrl: string;
  siteTitle?: string;
  scannedAt: string;
  scanDurationMs: number;

  score: number;
  verdict: SafetyVerdict;
  summary: string;

  trustSignals: string[];
  warningSignals: string[];
  recommendedActions: string[];

  checks: {
    https: {
      passed: boolean;
      protocol: "http" | "https";
      hstsPresent?: boolean;
      notes: string[];
      scoreImpact: number;
    };

    domain: {
      registrableDomain?: string;
      ageDays?: number;
      createdAt?: string;
      updatedAt?: string;
      expiresAt?: string;
      registrar?: string;
      notes: string[];
      scoreImpact: number;
    };

    redirects: {
      hopCount: number;
      chain: string[];
      suspicious: boolean;
      notes: string[];
      scoreImpact: number;
    };

    policies: {
      privacyFound: boolean;
      termsFound: boolean;
      contactFound: boolean;
      refundFound?: boolean;
      aboutFound?: boolean;
      matchedUrls?: {
        privacyUrl?: string;
        termsUrl?: string;
        contactUrl?: string;
        refundUrl?: string;
        aboutUrl?: string;
      };
      notes: string[];
      scoreImpact: number;
    };

    suspiciousPatterns: {
      matchedFlags: string[];
      notes: string[];
      scoreImpact: number;
    };

    brandConsistency: {
      suspiciousLookalike: boolean;
      titleDomainMismatch: boolean;
      notes: string[];
      scoreImpact: number;
    };

    reputation: {
      status: "clean" | "suspicious" | "malicious" | "unknown";
      provider?: string;
      notes: string[];
      scoreImpact: number;
    };

    technical: {
      statusCode?: number;
      canonicalUrl?: string;
      robotsMeta?: string;
      sitemapFound: boolean;
      securityHeaders: {
        contentSecurityPolicy: boolean;
        xFrameOptions: boolean;
        referrerPolicy: boolean;
        permissionsPolicy: boolean;
        xContentTypeOptions: boolean;
      };
      notes: string[];
      scoreImpact: number;
    };

    contacts: {
      emails: string[];
      phones: string[];
      socialProfiles: string[];
      notes: string[];
    };

    tlsCertificate?: {
      issuer?: string;
      validFrom?: string;
      validTo?: string;
      daysRemaining?: number;
      notes: string[];
    };
  };

  beginnerExplanation: string;
  disclaimer: string;
}