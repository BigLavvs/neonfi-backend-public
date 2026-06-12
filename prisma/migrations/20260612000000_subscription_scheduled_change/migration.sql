ALTER TABLE "subscription" ADD COLUMN "scheduledPlanId" INTEGER REFERENCES "plan"(id);
ALTER TABLE "subscription" ADD COLUMN "scheduledBillingCycleId" INTEGER REFERENCES "billing_cycle"(id);
CREATE INDEX "subscription_scheduledPlanId_idx" ON "subscription"("scheduledPlanId");
CREATE INDEX "subscription_scheduledBillingCycleId_idx" ON "subscription"("scheduledBillingCycleId");
