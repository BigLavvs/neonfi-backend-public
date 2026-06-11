-- CreateTable
CREATE TABLE "user" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" TEXT,
    "fullName" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(100),
    "avatarUrl" VARCHAR(2048),
    "authProviderId" INTEGER NOT NULL,
    "onboardingStatusId" INTEGER NOT NULL,
    "newsletterSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_provider" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "auth_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_status" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "onboarding_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(512),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "planId" INTEGER NOT NULL,
    "billingCycleId" INTEGER,
    "statusId" INTEGER NOT NULL,
    "stripeCustomerId" VARCHAR(255),
    "stripeSubscriptionId" VARCHAR(255),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "pros" TEXT[],
    "cons" TEXT[],

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_cycle" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "billing_cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_status" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "subscription_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "subscriptionId" INTEGER NOT NULL,
    "stripePaymentIntentId" VARCHAR(255) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "statusId" INTEGER NOT NULL,
    "refundAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "payment_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "logoUrl" VARCHAR(2048),
    "moralisId" VARCHAR(20) NOT NULL,

    CONSTRAINT "chain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "logoUrl" VARCHAR(2048),
    "currentPrice" DECIMAL(20,8) NOT NULL,
    "marketCap" DECIMAL(30,2),
    "rank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "typeId" INTEGER NOT NULL,
    "walletAddress" VARCHAR(255),
    "chainId" INTEGER,
    "startingBalance" DECIMAL(20,8),
    "netDeposit" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_type" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "portfolio_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "balance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "netDeposit" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "typeId" INTEGER NOT NULL,
    "from" VARCHAR(255),
    "to" VARCHAR(255),
    "gasFee" DECIMAL(20,8),
    "transactionHash" VARCHAR(255),
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_type" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "transaction_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_transaction_detail" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,

    CONSTRAINT "native_transaction_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erc20_transaction_detail" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "tokenContractAddress" VARCHAR(255) NOT NULL,
    "tokenName" VARCHAR(255) NOT NULL,
    "tokenSymbol" VARCHAR(20) NOT NULL,

    CONSTRAINT "erc20_transaction_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft_transaction_detail" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "tokenContractAddress" VARCHAR(255) NOT NULL,
    "nftName" VARCHAR(255),
    "nftTokenId" VARCHAR(255) NOT NULL,
    "collectionName" VARCHAR(255),

    CONSTRAINT "nft_transaction_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nft" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "name" VARCHAR(255),
    "tokenId" VARCHAR(255) NOT NULL,
    "contractAddress" VARCHAR(255) NOT NULL,
    "collectionName" VARCHAR(255),
    "logoUrl" VARCHAR(2048),
    "chain" VARCHAR(50) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_snapshot" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "value" DECIMAL(20,8) NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_authProviderId_idx" ON "user"("authProviderId");

-- CreateIndex
CREATE INDEX "user_onboardingStatusId_idx" ON "user"("onboardingStatusId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_provider_name_key" ON "auth_provider"("name");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_status_name_key" ON "onboarding_status"("name");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_userId_key" ON "subscription"("userId");

-- CreateIndex
CREATE INDEX "subscription_planId_idx" ON "subscription"("planId");

-- CreateIndex
CREATE INDEX "subscription_billingCycleId_idx" ON "subscription"("billingCycleId");

-- CreateIndex
CREATE INDEX "subscription_statusId_idx" ON "subscription"("statusId");

-- CreateIndex
CREATE UNIQUE INDEX "plan_name_key" ON "plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "billing_cycle_name_key" ON "billing_cycle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_status_name_key" ON "subscription_status"("name");

-- CreateIndex
CREATE UNIQUE INDEX "payment_stripePaymentIntentId_key" ON "payment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "payment_userId_idx" ON "payment"("userId");

-- CreateIndex
CREATE INDEX "payment_subscriptionId_idx" ON "payment"("subscriptionId");

-- CreateIndex
CREATE INDEX "payment_statusId_idx" ON "payment"("statusId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_status_name_key" ON "payment_status"("name");

-- CreateIndex
CREATE UNIQUE INDEX "chain_name_key" ON "chain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "chain_slug_key" ON "chain"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "chain_moralisId_key" ON "chain"("moralisId");

-- CreateIndex
CREATE UNIQUE INDEX "token_symbol_key" ON "token"("symbol");

-- CreateIndex
CREATE INDEX "portfolio_userId_idx" ON "portfolio"("userId");

-- CreateIndex
CREATE INDEX "portfolio_typeId_idx" ON "portfolio"("typeId");

-- CreateIndex
CREATE INDEX "portfolio_chainId_idx" ON "portfolio"("chainId");

-- CreateIndex
CREATE INDEX "portfolio_walletAddress_idx" ON "portfolio"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_type_name_key" ON "portfolio_type"("name");

-- CreateIndex
CREATE INDEX "asset_tokenId_idx" ON "asset"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_portfolioId_tokenId_key" ON "asset"("portfolioId", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_transactionHash_key" ON "transaction"("transactionHash");

-- CreateIndex
CREATE INDEX "transaction_portfolioId_idx" ON "transaction"("portfolioId");

-- CreateIndex
CREATE INDEX "transaction_typeId_idx" ON "transaction"("typeId");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_type_name_key" ON "transaction_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "native_transaction_detail_transactionId_key" ON "native_transaction_detail"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "erc20_transaction_detail_transactionId_key" ON "erc20_transaction_detail"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "nft_transaction_detail_transactionId_key" ON "nft_transaction_detail"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "nft_portfolioId_contractAddress_tokenId_key" ON "nft"("portfolioId", "contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "balance_snapshot_userId_idx" ON "balance_snapshot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "balance_snapshot_portfolioId_snapshotDate_key" ON "balance_snapshot"("portfolioId", "snapshotDate");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_authProviderId_fkey" FOREIGN KEY ("authProviderId") REFERENCES "auth_provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_onboardingStatusId_fkey" FOREIGN KEY ("onboardingStatusId") REFERENCES "onboarding_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_billingCycleId_fkey" FOREIGN KEY ("billingCycleId") REFERENCES "billing_cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "subscription_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "payment_status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "portfolio_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "chain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "transaction_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_transaction_detail" ADD CONSTRAINT "native_transaction_detail_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erc20_transaction_detail" ADD CONSTRAINT "erc20_transaction_detail_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft_transaction_detail" ADD CONSTRAINT "nft_transaction_detail_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nft" ADD CONSTRAINT "nft_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
