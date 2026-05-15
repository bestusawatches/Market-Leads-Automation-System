import EventEmitter from "events";

export type ScrapeStatus = {
  running: boolean;
  scrapingId?: string;
  startedAt?: string;
  finishedAt?: string;
  current?: string;
  total?: number;
  completed?: number;
  percent?: number;
  stopRequested?: boolean;
};

const emitter = new EventEmitter();

let status: ScrapeStatus = { running: false, percent: 0, total: 0, completed: 0 };

export function getStatus(): ScrapeStatus {
  return { ...status };
}

export function setRunning(running: boolean, scrapingId?: string) {
  status.running = running;
  if (running) {
    status.scrapingId = scrapingId ?? status.scrapingId;
    status.startedAt = new Date().toISOString();
    status.finishedAt = undefined;
    status.completed = 0;
    status.percent = 0;
    status.stopRequested = false;
  } else {
    status.finishedAt = new Date().toISOString();
  }
  emitter.emit("update", getStatus());
}

export function setProgress(partial: Partial<Pick<ScrapeStatus, "current" | "total" | "completed">>) {
  if (partial.current !== undefined) status.current = partial.current;
  if (partial.total !== undefined) status.total = partial.total;
  if (partial.completed !== undefined) status.completed = partial.completed;
  if (status.total && status.completed !== undefined) {
    status.percent = Math.round((status.completed! / status.total!) * 100);
  }
  emitter.emit("update", getStatus());
}

export function requestStop() {
  status.stopRequested = true;
  emitter.emit("update", getStatus());
}

export function onUpdate(cb: (s: ScrapeStatus) => void) {
  emitter.on("update", cb);
}

export function offUpdate(cb: (s: ScrapeStatus) => void) {
  emitter.off("update", cb);
}

export default {
  getStatus,
  setRunning,
  setProgress,
  requestStop,
  onUpdate,
  offUpdate,
};

// Help me setup address normalization helpers for the creative listing addresses, and the address of a creative listing, {
//       "source": "creativelisting",
//       "url": "https://www.creativelisting.com/listing/286alhambrawayakronoh44302",
//       "address": "286 Alhambra WAY, Akron, OH 44302",
//       "city": "Akron",
//       "state": "OH",
//       "zip": "44302",
//       "price": 123453.39,
//       "bedrooms": 3,
//       "bathrooms": 2,
//       "squareFeet": 1724,
//       "lotSize": 3589,
//       "yearBuilt": 1900,
//       "propertyType": "single_family",
//       "description": "ENTRY:\n\n-- Cash to Close: $13,300 + Closing Costs\n\n -- EMD: $5,000 Non-refundable (Due within 24 hours of signing the assignment contract)\n\n-- Purchase Type: Subject-To the Existing Mortgage\n\n\n\n\nPROPERTY OVERVIEW:\n\n-- 3-bedroom, 2-bathroom home -- 1,724 sqft of living space\n\n-- Built in 1900\n\n-- Lot Size: 3,589 sqft\n\n-- Located in Akron, OH 44302 — affordable market with strong upside for cash flow strategies\n\n\n\n\nLOAN DETAILS (SUBJECT-TO):\n\n-- Remaining Mortgage: $110,153.39\n\n-- Interest Rate: 5.5%\n\n-- Total PITI: $1,049.25/month\n\n-- Principal: $155.73/month\n\n-- Interest: $504.87/month\n\n-- Taxes/Insurance: $388.65/month\n\n-- HOA Payment: $0.00/month\n\n\n\n\nRENTAL STRATEGY & RETURNS:\n\n-- Long-Term Rental (LTR): ~$1,400/month → $350.75 Monthly CoC (31.65% ROI)\n\n-- Mid-Term Rental (MTR): ~$2,400/month → $1,350.75 Monthly CoC (121.87% ROI)\n\n-- Short-Term Rental (STR): ~$1,755/month → $705.75 Monthly CoC (63.68% ROI)\n\n-- Section 8: ~$1,309/month → $259.75 Monthly CoC (23.44% ROI)\n\n\n\n\nCONTACT: Call or Text Louie Today at 805-345-5338\n\n\n\n\n\"You miss 100% of the shots you don’t take — submit your offer before someone else does!\"",
//       "photos": [
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/067d8367c81cb96ead124937703fd0b9-1778551238209.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/d335a9b67de23390915fb10fb4f11506-1778551238212.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/8867e6753e1ac214419b69c45ac852f1-1778551238211.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/5c012a8b2cc5c24f032a4827046f33c8-1778551238222.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/a6da80cbb6ed1dcc34727e4ca4168a96-1778551238227.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/0432d48b771b131c9de1cb124f29a203-1778551238228.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/dc9e3f9ad26df151f834a3708d112d7d-1778551238246.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/1e0ca389aca18add040efa45c842b841-1778551238230.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/e5b9b13b343818eb381db5737b3a755d-1778551238214.png",
//         "https://db7z26wykqpga.cloudfront.net/deal-photos/9b1491d95eaa2321f5289289abc9a94f-1778551238225.png"
//       ],
//       "lat": 41.094592,
//       "lng": -81.55065309999999,
//       "_clDealId": "85055de8-e351-464d-925a-da3cb3b34c0f",
//       "_clDealCategory": "creative",
//       "_clPurchaseType": "SubTo",
//       "_clMonthlyCost": 1049.25,
//       "_clDownPayment": 13300,
//       "_clEmd": 5000,
//       "_clTags": [],
//       "_clOriginator": {
//         "name": "Brad Lewis",
//         "email": "buyhomes995@gmail.com",
//         "phoneNumber": "6822738445",
//         "callBookingLink": null,
//         "companyInfo": {
//           "name": null,
//           "phone": null,
//           "email": null,
//           "logoUrl": null
//         },
//         "isPremium": false,
//         "publicBuyBoxUrl": null
//       },
//       "_clSubToLoans": [
//         {
//           "interestRate": 5.5,
//           "loanType": "FHA",
//           "loanMaturity": "2052-07-11",
//           "loanDescription": "Primary mortgage",
//           "piti": 1049.25,
//           "id": "944ed30c-b63a-4856-91d8-c024c8497a8b",
//           "loanBalance": 110153.39,
//           "order": 1
//         }
//       ],
//       "_clSellerLoans": []
//     }, a zillow address: {
//           "url": "https://www.zillow.com/homedetails/35083589_zpid/",
//           "source": "zillow",
//           "title": "2222 Wayne Ave, Dayton, OH 45410",
//           "address": "2222 Wayne Ave, Dayton, OH 45410, Dayton, OH, 45410",
//           "price": 69500,
//           "zestimate": 1485,
//           "bedrooms": 3,
//           "bathrooms": 2,
//           "squareFeet": 1878,
//           "propertyType": "unknown",
//           "description": "",
//           "listedAt": "2026-04-14T15:32:21.382Z",
//           "daysOnZillow": 29,
//           "listingType": "foreclosure"
//         }, redfin address:  {
//               "url": "https://www.redfin.com/OH/Cleveland/3557-E-114th-St-44105/home/70790131",
//               "source": "redfin",
//               "title": "3557 E 114th St, Cleveland, OH, 44105",
//               "address": "3557 E 114th St, Cleveland, OH, 44105",
//               "price": 160000,
//               "bedrooms": 2,
//               "bathrooms": 2,
//               "squareFeet": 1496,
//               "propertyType": "single_family",
//               "description": "",
//               "listedAt": "2026-05-10T19:11:53.339Z",
//               "daysOnMarket": 1,
//               "_redfinPropertyId": 70790131
//             }, propwire address: 