(async function(){

function q(doc,sel){
 return doc.querySelector(sel);
}

function txt(doc,sel){
 return q(doc,sel)?.innerText?.trim() || null;
}

function attr(el,sel,a){
 return el.querySelector(sel)?.getAttribute(a)||null;
}

function sleep(ms){
 return new Promise(r=>setTimeout(r,ms));
}


// lazy load listings
for(let i=0;i<6;i++){
 window.scrollBy(0,3000);
 await sleep(1500);
}

const cards=[
...document.querySelectorAll(
 ".HomeCard,.MapHomeCardReact"
)
];

let listings=cards.map(card=>{

 const href=attr(
   card,
   'a[href*="/home/"]',
   'href'
 );

 return{
   address:
    card.querySelector(".collapsedAddress")
      ?.innerText?.trim(),

   listPrice:
    card.querySelector(".homecardV2Price")
      ?.innerText?.trim(),

   beds:
    card.querySelectorAll(".stats")[0]
      ?.innerText||null,

   baths:
    card.querySelectorAll(".stats")[1]
      ?.innerText||null,

   sqft:
    card.querySelectorAll(".stats")[2]
      ?.innerText||null,

   url: href
      ? "https://www.redfin.com"+href
      : null,

   redfinEstimate:null,
   monthlyEstimate:null
 };

});

console.log(
 "Found",
 listings.length,
 "listings"
);


// visit detail pages
for(
 let i=0;
 i<Math.min(listings.length,10);
 i++
){

 let listing=listings[i];

 if(!listing.url) continue;

 console.log(
   "Fetching",
   listing.address
 );

 try{

  let iframe=document.createElement("iframe");
  iframe.style.display="none";
  iframe.src=listing.url;

  document.body.appendChild(iframe);

  await new Promise(r=>{
    iframe.onload=r;
  });

  await sleep(4000);

  const doc=
    iframe.contentDocument ||
    iframe.contentWindow.document;


  // ------------------------
  // Monthly estimate
  // ------------------------
  listing.monthlyEstimate =
   txt(
    doc,
 '[data-rf-test-id="abp-monthly-payment-entry-point-estimate"]'
   );


  // ------------------------
  // Try direct Redfin Estimate DOM selectors
  // ------------------------

  const estimateSelectors=[
   '[data-rf-test-id="avm-estimate"]',
   '[data-rf-test-id="redfin-estimate"]',
   '.RedfinEstimate',
   '.statsValue'
  ];

  for(
    const sel of estimateSelectors
  ){
     let val=txt(doc,sel);
     if(
       val &&
       val.includes("$")
     ){
       listing.redfinEstimate=val;
       break;
     }
  }


  // ------------------------
  // Fallback:
  // parse scripts for Redfin Estimate
  // ------------------------

 if(!listing.redfinEstimate){

   const scripts=[
     ...doc.querySelectorAll("script")
   ];

   for(
    const s of scripts
   ){

    const t=s.textContent||"";

    const match=t.match(
      /Redfin Estimate[^$]*\$([\d,]+)/i
    ) || t.match(
      /"avmValue":\s*([0-9]+)/i
    );

    if(match){
      listing.redfinEstimate=
       match[1].startsWith("$")
        ? match[1]
        : "$"+
          Number(match[1])
            .toLocaleString();

      break;
    }

   }
 }

 iframe.remove();

 }catch(e){
   console.warn(
    "Failed:",
    listing.address,
    e
   );
 }

 await sleep(1500);

}


console.table(
 listings.map(x=>({
  address:x.address,
  listPrice:x.listPrice,
  redfinEstimate:x.redfinEstimate,
  mortgage:x.monthlyEstimate
 }))
);


window.redfinListings=listings;

console.log(
 "Saved as window.redfinListings",
 listings
);


// download
const blob=new Blob(
 [JSON.stringify(listings,null,2)],
 {type:"application/json"}
);

const a=document.createElement("a");
a.href=URL.createObjectURL(blob);
a.download="redfin_estimates.json";
a.click();

})();