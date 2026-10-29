-- AddForeignKey
ALTER TABLE "ClassificationRecord" ADD CONSTRAINT "ClassificationRecord_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationCandidate" ADD CONSTRAINT "ClassificationCandidate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
