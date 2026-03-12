"use client";

import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";

export default function ApiEndpointsTab() {
  const t = useTranslations("endpoints");

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Card className="p-8 text-center space-y-4">
        <div className="flex items-center justify-center size-16 rounded-2xl bg-primary/10 text-primary mx-auto">
          <span className="material-symbols-outlined text-[32px]">code</span>
        </div>
        <h2 className="text-xl font-semibold">{t("apiEndpointsTitle")}</h2>
        <p className="text-sm text-text-muted max-w-md mx-auto">{t("apiEndpointsDescription")}</p>
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/10 text-amber-500 text-sm font-medium">
          <span className="material-symbols-outlined text-[18px]">construction</span>
          {t("comingSoon")}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold mb-3">{t("plannedFeatures")}</h3>
        <ul className="space-y-2 text-sm text-text-muted">
          <li className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>
            {t("featureRestApi")}
          </li>
          <li className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>
            {t("featureWebhooks")}
          </li>
          <li className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>
            {t("featureSwagger")}
          </li>
          <li className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>
            {t("featureAuth")}
          </li>
        </ul>
      </Card>
    </div>
  );
}
