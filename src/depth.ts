// src/depth.ts
import axios from "axios";

const CLOB_API = "https://clob.polymarket.com";

export interface OrderBook {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
}

function parsePrice(val: any): number {
  if (val === undefined || val === null) return 0;

  const num = parseFloat(val);
  if (isNaN(num)) return 0;

  // Polymarket kadang return 46 => 0.46
  return num > 1 ? num / 100 : num;
}

export async function getOrderBook(
  tokenId: string
): Promise<OrderBook | null> {
  try {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;

    const res = await axios.get(url, { timeout: 5000 });

    const data = res.data;

    return {
      bids: (data.bids || [])
        .map((b: any) => ({
          price: parsePrice(b.price),
          size: parseFloat(b.size || 0)
        }))
        .filter(x => x.price > 0 && x.size > 0),

      asks: (data.asks || [])
        .map((a: any) => ({
          price: parsePrice(a.price),
          size: parseFloat(a.size || 0)
        }))
        .filter(x => x.price > 0 && x.size > 0)
    };

  } catch (e) {
    console.error(`[Depth] orderbook fetch failed: ${e}`);
    return null;
  }
}

//
// MID PRICE SPREAD (lebih stabil buat prediction market)
//
export function getSpreadPercent(ask: number, bid: number): number {
  if (ask <= 0 || bid <= 0) return Infinity;
  const mid = (ask + bid) / 2;
  return (ask - bid) / mid;
}

export function isSpreadAcceptable(
 spreadPercent:number,
 maxSpread:number=0.05
):boolean{
 return spreadPercent<=maxSpread;
}

export function getSpreadScore(
 spreadPercent:number
):number{

 if (spreadPercent>=0.10) return 0;

 if (spreadPercent<=0.02) return 100;

 return Math.max(
   0,
   100-((spreadPercent-0.02)/0.08)*100
 );
}

export async function getBestBidAsk(
 tokenId:string
):Promise<{
 bid:number;
 ask:number;
 bidSize:number;
 askSize:number;
 spread:number;
 spreadPercent:number;
 spreadScore:number;
}|null>{

 const book=await getOrderBook(tokenId);

 if(!book) return null;
 if(!book.bids.length || !book.asks.length) return null;

 // FIX:
 // highest bid
 const sortedBids=[...book.bids]
   .sort((a,b)=>b.price-a.price);

 // lowest ask
 const sortedAsks=[...book.asks]
   .sort((a,b)=>a.price-b.price);

 const bid=sortedBids[0].price;
 const ask=sortedAsks[0].price;

 // reject broken book
 if(ask<=bid){
   console.log("[DEPTH] crossed/broken book ignored");
   return null;
 }

 const spread=ask-bid;
 const spreadPercent=getSpreadPercent(ask,bid);
 const spreadScore=getSpreadScore(spreadPercent);

 if(spreadPercent>0.05){
   console.log(
    `[DEPTH] Wide spread ${(spreadPercent*100).toFixed(2)}% `
    + `(bid ${bid} ask ${ask})`
   );
 }

 return {
   bid,
   ask,
   bidSize:sortedBids[0].size,
   askSize:sortedAsks[0].size,
   spread,
   spreadPercent,
   spreadScore
 };
}



export async function isLiquidEnough(
 tokenId:string,
 requiredShares:number,
 slippagePercent:number=10
):Promise<boolean>{

 const book=await getOrderBook(tokenId);

 if(!book || !book.asks.length) return false;

 const asks=[...book.asks]
  .sort((a,b)=>a.price-b.price);

 const bestAsk=asks[0].price;

 const maxPrice=
   bestAsk*(1+slippagePercent/100);

 let filled=0;
 let cost=0;

 for(const ask of asks){

   if(ask.price>maxPrice) break;

   const need=requiredShares-filled;
   const take=Math.min(ask.size,need);

   filled+=take;
   cost+=take*ask.price;

   if(filled>=requiredShares) break;
 }

 if(filled<requiredShares){
   console.log(
    `[Depth] insufficient liquidity `
    + `${filled.toFixed(1)}/${requiredShares.toFixed(1)}`
   );
   return false;
 }

 const avg=cost/requiredShares;

 const slippage=
  ((avg-bestAsk)/bestAsk)*100;

 console.log(
  `[Depth] filled ${filled.toFixed(1)} `
  + `slippage ${slippage.toFixed(2)}%`
 );

 return true;
}



export async function getMarketVolume(
 tokenId:string
):Promise<{
 volume24h:number;
 volume7d:number;
}>{

 try{

   const url=
    `${CLOB_API}/markets/${tokenId}/volume`;

   const res=
    await axios.get(url,{timeout:5000});

   return{
    volume24h:res.data?.volume_24h||0,
    volume7d:res.data?.volume_7d||0
   };

 }catch{
   return{
    volume24h:0,
    volume7d:0
   };
 }

}
