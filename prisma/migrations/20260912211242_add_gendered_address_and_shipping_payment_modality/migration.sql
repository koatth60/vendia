-- CreateEnum
CREATE TYPE "ShippingPaymentModality" AS ENUM ('PREPAID_ALL', 'PREPAID_PRODUCT_COD_SHIPPING', 'COD_ALL');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "femaleAddressTerm" TEXT,
ADD COLUMN     "genderedAddressEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maleAddressTerm" TEXT,
ADD COLUMN     "shippingPaymentModalities" "ShippingPaymentModality"[] DEFAULT ARRAY[]::"ShippingPaymentModality"[];
