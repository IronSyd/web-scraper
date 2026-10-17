/**
 * @typedef {{ranking:number,pLang:string,imagePath:string}} Language
 * @typedef {{searchTerm:string,title:string,authors:string[],url:string,price:string|null,rating:string|null,reviews:string|null,image:string|null}} Book
 * @typedef {Language[]|Book[]} CacheData
 * @typedef {{source:'collection'|'cache',data:CacheData}} CollectionResponse
 * @typedef {{get:(key:string)=>Promise<CacheData|null>,set:(key:string,data:CacheData)=>Promise<void>}} CacheRepository
 * @typedef {{tiobe:()=>Promise<Language[]>,amazon:(query:string)=>Promise<Book[]>}} Collectors
 * @typedef {'amazon'|'booking'|'indeed'|'tiobe'} Source
 * @typedef {Record<string,string|number>} RunInputs
 * @typedef {{jobId:string,title:string,company:string,location:string,url:string}} Job
 * @typedef {{name:string,url:string,price:string|null,currency:string|null,rating:string|null,reviewCount:number|null,location:string|null}} Hotel
 * @typedef {Language[]|Book[]|Job[]|Hotel[]} RunData
 * @typedef {{code:string,message:string}} RunError
 * @typedef {{id:string,source:Source,inputs:RunInputs,status:'running'|'succeeded'|'failed',provenance:'collection'|'legacy-cache',createdAt:string|null,startedAt:string|null,completedAt:string|null,collectedAt:string|null,savedAt:string|null,resultCount:number,data:RunData|null,error:RunError|null}} Run
 * @typedef {Omit<Run,'data'>} RunSummary
 * @typedef {{time:number,tie:string}} RunCursor
 * @typedef {{source?:Source,limit:number,cursor:RunCursor|null}} HistoryOptions
 * @typedef {{runs:RunSummary[],nextCursor:string|null}} RunHistory
 * @typedef {{get:(id:string)=>Promise<Run|null>,insert:(run:Run)=>Promise<boolean>,finish:(run:Run)=>Promise<Run|null>,list:(options:HistoryOptions)=>Promise<RunHistory>,latest:(source:Source,inputs?:RunInputs)=>Promise<Run|null>}} RunRepository
 * @typedef {Partial<Record<Source,(inputs:RunInputs,signal:AbortSignal)=>Promise<RunData>>>} RunCollectors
 */
export {};
