/**
 * DEMO seed.
 *
 * Everything created here lives in the DEMO data namespace and is labelled
 * DEMO in every export, report and API response. Synthetic leads are never
 * mixed into real reporting, and no synthetic company is presented as a real
 * customer.
 *
 * The initial owner account uses a one-time random password printed to the
 * console; it is never written to disk or to the repo.
 */
import { PrismaClient, DataSource, MemberRole, PlanCode } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "../src/password.js";

const prisma = new PrismaClient();

/** SHA-256 hex of a session/api token. */
function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function main() {
  console.log("[seed] preparing DEMO tenant");

  // Plans (trial pricing assumptions, explicitly not verified market prices).
  const plans = [
    {
      code: PlanCode.FREE,
      nameZh: "免费版",
      nameEn: "Free",
      priceUsdMonthly: 0,
      maxActiveSkus: 3,
      apiCallsPerDay: 100,
      features: { singleProductCalculator: true, csvImport: false, scenarios: false, growth: false, api: false },
    },
    {
      code: PlanCode.SELLER,
      nameZh: "卖家版（试售）",
      nameEn: "Seller (trial pricing)",
      priceUsdMonthly: 29,
      maxActiveSkus: 50,
      apiCallsPerDay: 2000,
      features: { singleProductCalculator: true, csvImport: true, scenarios: true, growth: false, api: true },
    },
    {
      code: PlanCode.BUSINESS,
      nameZh: "商业版（试售）",
      nameEn: "Business (trial pricing)",
      priceUsdMonthly: 79,
      maxActiveSkus: 500,
      apiCallsPerDay: 10000,
      features: { singleProductCalculator: true, csvImport: true, scenarios: true, growth: true, api: true, alerts: true },
    },
    {
      code: PlanCode.SERVICE_PROVIDER,
      nameZh: "服务商版（试售）",
      nameEn: "Service Provider (trial pricing)",
      priceUsdMonthly: 199,
      maxActiveSkus: null,
      apiCallsPerDay: 20000,
      features: { multiClient: true, clientAccessGrants: true, growth: true, api: true },
    },
    {
      code: PlanCode.DEVELOPER,
      nameZh: "开发者版",
      nameEn: "Developer",
      priceUsdMonthly: null,
      maxActiveSkus: null,
      apiCallsPerDay: 50000,
      features: { api: true, mcp: true, skills: true },
    },
    {
      code: PlanCode.PROFESSIONAL_REVIEW,
      nameZh: "专业复核（单独报价）",
      nameEn: "Professional Review (quoted separately)",
      priceUsdMonthly: null,
      maxActiveSkus: null,
      apiCallsPerDay: null,
      features: { expertReview: true },
    },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({ where: { code: p.code }, update: p, create: p });
  }
  console.log(`[seed] ${plans.length} plans`);

  // Owner account with a one-time random password.
  const password = randomBytes(12).toString("base64url");
  const ownerEmail = process.env.DEMO_OWNER_EMAIL ?? "owner@demo.local";
  const owner = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      email: ownerEmail,
      passwordHash: hashPassword(password),
      displayName: "演示组织 Owner",
      emailVerified: true,
      locale: "zh-CN",
    },
  });

  const demoOrg = await prisma.organization.upsert({
    where: { slug: "demo-org" },
    update: { dataMode: DataSource.DEMO },
    create: {
      name: "演示组织（DEMO）",
      slug: "demo-org",
      dataMode: DataSource.DEMO,
      ownerId: owner.id,
    },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: owner.id, organizationId: demoOrg.id } },
    update: { role: MemberRole.OWNER },
    create: { userId: owner.id, organizationId: demoOrg.id, role: MemberRole.OWNER },
  });

  await prisma.entitlement.upsert({
    where: { organizationId_planCode_startsAt: { organizationId: demoOrg.id, planCode: PlanCode.FREE, startsAt: new Date("2020-01-01") } },
    update: {},
    create: {
      organizationId: demoOrg.id,
      planCode: PlanCode.FREE,
      limits: { maxActiveSkus: 3, apiCallsPerDay: 100 },
      startsAt: new Date("2020-01-01"),
    },
  });

  // A second DEMO org, used to prove cross-tenant isolation in acceptance runs.
  const otherOwner = await prisma.user.upsert({
    where: { email: "owner2@demo.local" },
    update: {},
    create: {
      email: "owner2@demo.local",
      passwordHash: hashPassword(password),
      displayName: "演示组织 B Owner",
      emailVerified: true,
    },
  });
  const orgB = await prisma.organization.upsert({
    where: { slug: "demo-org-b" },
    update: { dataMode: DataSource.DEMO },
    create: { name: "演示组织 B（DEMO）", slug: "demo-org-b", dataMode: DataSource.DEMO, ownerId: otherOwner.id },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: otherOwner.id, organizationId: orgB.id } },
    update: { role: MemberRole.OWNER },
    create: { userId: otherOwner.id, organizationId: orgB.id, role: MemberRole.OWNER },
  });

  // Synthetic DEMO product with a synthetic (not real) classification.
  const product = await prisma.product.upsert({
    where: { organizationId_sku: { organizationId: demoOrg.id, sku: "DEMO-SKU-001" } },
    update: {},
    create: {
      organizationId: demoOrg.id,
      sku: "DEMO-SKU-001",
      nameZh: "演示商品：不锈钢保温杯（DEMO，非真实货物）",
      nameEn: "DEMO product: stainless steel vacuum flask (synthetic)",
      descriptionZh: "合成演示数据，用于验证成本与利润计算，不代表任何真实商品。",
      materialText: "stainless steel body (synthetic)",
      unitOfMeasure: "PCS",
      status: "NEEDS_INFO",
      dataSource: DataSource.DEMO,
      createdById: owner.id,
    },
  });

  await prisma.productVersion.upsert({
    where: { productId_versionNo: { productId: product.id, versionNo: 1 } },
    update: {},
    create: {
      productId: product.id,
      organizationId: demoOrg.id,
      versionNo: 1,
      changeReason: "initial DEMO version",
      snapshot: {
        sku: "DEMO-SKU-001",
        materialText: "stainless steel body (synthetic)",
        classification: { htsCode: "9617.00.10 (DEMO candidate, unconfirmed)", status: "CANDIDATE_RESEARCH" },
      },
      createdById: owner.id,
    },
  });

  // Synthetic DEMO leads - explicitly not real companies.
  const demoLeads = [
    {
      companyName: "DEMO 电商卖家 A",
      normalizedDomain: "demo-seller-a.example",
      leadType: "SELLER" as const,
      fitReason: "合成演示线索：用于验证漏斗与证据展示。",
      unknowns: ["真实团队规模未知", "真实采购来源未知"],
    },
    {
      companyName: "DEMO 货代 B",
      normalizedDomain: "demo-forwarder-b.example",
      leadType: "FREIGHT_FORWARDER" as const,
      fitReason: "合成演示线索：用于验证服务商画像。",
      unknowns: ["是否服务美国航线未知"],
    },
  ];
  for (const l of demoLeads) {
    const existing = await prisma.lead.findFirst({
      where: { organizationId: demoOrg.id, normalizedDomain: l.normalizedDomain },
    });
    if (!existing) {
      await prisma.lead.create({
        data: {
          organizationId: demoOrg.id,
          companyName: l.companyName,
          normalizedDomain: l.normalizedDomain,
          leadType: l.leadType,
          dataSource: DataSource.DEMO,
          fitReason: l.fitReason,
          unknowns: l.unknowns,
          sourceUrls: [],
          scoreBreakdown: {
            total: 0,
            breakdown: [
              { dimension: "US_IMPORT_RELEVANCE", maxPoints: 30, points: 0, state: "UNKNOWN", evidence: null },
              { dimension: "COST_PAIN", maxPoints: 25, points: 0, state: "UNKNOWN", evidence: null },
            ],
            rulesVersion: "v1",
          },
        },
      });
    }
  }

  // Feature flags default OFF for anything gated.
  const flags = [
    { key: "REAL_CLASSIFICATION_RECOMMENDATION", description: "Controlled: full classification recommendation requires professional partner + legal review", enabled: false },
    { key: "OUTBOUND_SEND", description: "Controlled: real outbound sending (email/DM) requires channel + authorization", enabled: false },
    { key: "REAL_PAYMENT", description: "Controlled: real payment capture stays off; sandbox only", enabled: false },
    { key: "EXTERNAL_LLM", description: "Model-backed agents; disabled means RULE_BASED mode", enabled: false },
  ];
  for (const f of flags) {
    await prisma.featureFlag.upsert({ where: { key: f.key }, update: f, create: f });
  }

  console.log("");
  console.log("[seed] DEMO data ready.");
  console.log("");
  console.log("  DEMO owner login (one-time password, not stored anywhere):");
  console.log(`    email:    ${ownerEmail}`);
  console.log(`    password: ${password}`);
  console.log("");
  console.log("  Second DEMO org owner (for cross-tenant isolation tests):");
  console.log("    email:    owner2@demo.local");
  console.log(`    password: ${password}`);
  console.log("");
  console.log("  All seeded records are DataSource=DEMO and are excluded from");
  console.log("  real reporting by default.");
}

main()
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
