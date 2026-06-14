-- retrofit-5: account deletion (DELETE /users/me) + notification preferences.
--
-- Delta A — make Payment.subscriptionId survivable so a user can be hard-deleted.
-- The user→subscription relation cascades (subscription_userId_fkey), but a Payment
-- referencing that subscription via the existing RESTRICT FK would block the delete.
-- Mirroring payment_userId_fkey (already SET NULL), we drop NOT NULL on subscriptionId
-- and re-create the FK with ON DELETE SET NULL. After a user is deleted, orphaned
-- payment rows survive with userId=null AND subscriptionId=null for accounting.
ALTER TABLE "payment" DROP CONSTRAINT "payment_subscriptionId_fkey";

ALTER TABLE "payment" ALTER COLUMN "subscriptionId" DROP NOT NULL;

ALTER TABLE "payment" ADD CONSTRAINT "payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Delta B — notification/display preferences on the user (settings Preferences tab).
ALTER TABLE "user" ADD COLUMN "priceAlertsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user" ADD COLUMN "pushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "baseCurrency" VARCHAR(3) NOT NULL DEFAULT 'USD';
