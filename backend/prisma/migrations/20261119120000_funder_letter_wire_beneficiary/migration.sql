-- Payoff letter wire block: beneficiary (account holder) name and address.
-- Bank address stays in letterWireAddressLine1 / letterWireCityStateZip.
ALTER TABLE "FunderProfile"
ADD COLUMN IF NOT EXISTS "letterWireBeneficiaryName" TEXT,
ADD COLUMN IF NOT EXISTS "letterWireBeneficiaryAddress" TEXT;
