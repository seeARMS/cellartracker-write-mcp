// Adapted from the MIT-licensed local cellartracker-write-mcp.
import {parseHistory,parseConsumptionDetails} from './history.js';
import {validateConsumption} from './validation.js';
import { load } from 'cheerio/slim';
import { SafeError, type Bottle, type Inventory, type Transport, type ConsumptionCellar, type ConsumptionDetails, type ConsumptionHistory } from './types.js';

export function parseInventory(html: string) {
  const $ = load(html);
  const accountHref = $('#header a[href*="user.asp?iUserOverride="]').attr('href');
  const accountId = accountHref && new URL(accountHref, 'https://www.cellartracker.com/').searchParams.get('iUserOverride');
  if (!accountId || !/^\d+$/.test(accountId)) throw new SafeError('Not signed in, account identity unavailable, or the site layout changed. Renew the cloud session through the approved secure setup flow.');
  const paging = $('#top_gotolink').text().match(/page\s+([\d,]+)\s+of\s+([\d,]+)/i);
  const number = (s: string) => Number(s.replaceAll(',', ''));
  const countText = $('a').toArray().map(e => $(e).text()).find(t => /In My Cellar\s*\([\d,]+ bottles?\)/i.test(t));
  const count = countText?.match(/\(([\d,]+) bottles?\)/i);
  if (!count) throw new SafeError('Cannot verify inventory total; refusing an incomplete inventory.');
  const total = number(count[1]);
  if (total > 0 && !paging) throw new SafeError('Inventory pagination is missing.');
  if (total > 0 && !$('#main_table a[href*="O=BinSort"]').length) throw new SafeError('Bin column is not enabled; restore the standard Individual Bottles view.');
  const bottles: Bottle[] = [];
  $('#main_table tr').each((_, row) => {
    const r = $(row);
    const checkbox = r.find('input[name="iInventory"]');
    if (!checkbox.length) return;
    const id = checkbox.attr('value');
    const cell = r.find('span.bar').closest('td');
    const loc = cell.find('span.loc');
    const bin = cell.find('span.bin');
    const wine = r.find('td.name h3').text().trim();
    if (!id || !/^\d+$/.test(id) || !wine || loc.length !== 1 || bin.length > 1) throw new SafeError('Bottle markup changed; refusing to infer missing fields.');
    const wineHref=r.find('a[href^="wine.asp?iWine="]').first().attr('href');
    const wineId=wineHref && new URL(wineHref,'https://www.cellartracker.com').searchParams.get('iWine');
    const size=r.find('span.siz').text().trim();
    if(!wineId || !/^\d+$/.test(wineId) || !size)throw new SafeError('Wine ID or bottle size is missing; restore the standard bottle view.');
    bottles.push({ id: BigInt(id).toString(), wine, wineId:BigInt(wineId).toString(), size, location: loc.text().trim(), bin: bin.text().trim() });
  });
  return { accountId, bottles, total, page: paging ? number(paging[1]) : 1, pages: paging ? number(paging[2]) : 1 };
}

export class CellarTracker implements ConsumptionCellar {
  constructor(private transport: Transport) {}
  async inventory(): Promise<Inventory> {
    const bottles: Bottle[] = [];
    let expected: ReturnType<typeof parseInventory> | undefined;
    for (let page = 1; ; page++) {
      const response = await this.transport.request({kind:'inventory', page});
      this.checkResponse(response.status, response.url);
      const data = parseInventory(response.text);
      expected ??= data;
      if (data.page !== page || data.pages !== expected.pages || data.total !== expected.total || data.accountId !== expected.accountId || data.pages > 100) throw new SafeError('Inventory changed while paging or pagination is inconsistent. Read again before moving.');
      bottles.push(...data.bottles);
      if (page === data.pages) break;
    }
    if (bottles.length !== expected!.total || new Set(bottles.map(b=>b.id)).size !== bottles.length) throw new SafeError('Inventory is incomplete or contains duplicate bottle IDs. No move performed.');
    return {accountId: expected!.accountId, bottles};
  }
  async consumed(ids: string[]): Promise<ConsumptionHistory> {
    const rows: ReturnType<typeof parseHistory>['records']=[];let expected:ReturnType<typeof parseHistory>|undefined;
    for(let page=1;;page++){
      const response=await this.transport.request({kind:'consumed',page});this.checkResponse(response.status,response.url);
      const data=parseHistory(response.text);expected??=data;
      if(data.page!==page||data.pages!==expected.pages||data.total!==expected.total||data.accountId!==expected.accountId||data.pages>100)throw new SafeError('Consumption history changed while paging.');
      rows.push(...data.records);if(page===data.pages)break;
    }
    if(rows.length!==expected!.total||new Set(rows.map(r=>r.consumedId)).size!==rows.length)throw new SafeError('Consumption history is incomplete or duplicated.');
    const records:ConsumptionHistory['records']=[];
    for(const row of rows.filter(r=>ids.includes(r.id))){
      const response=await this.transport.request({kind:'consumptionDetails',wineId:row.wineId,consumedId:row.consumedId});this.checkResponse(response.status,response.url);
      const details=parseConsumptionDetails(response.text,row);if(details.accountId!==expected!.accountId)throw new SafeError('Account changed while reading consumption details.');
      records.push({...row,date:details.date,type:details.type,note:details.note});
    }
    return {accountId:expected!.accountId,records};
  }
  async prepareConsumption(details: ConsumptionDetails) {
    validateConsumption(details);
    const form=await this.transport.request({kind:'consumptionForm'});this.checkResponse(form.status,form.url);
    const $=load(form.text);const f=$('#bulk_popup_form');
    const required=['Consumed','iConsumptionType','ConsumptionNote','Revenue','RevenueCurrency','WriteTN'];
    if(f.attr('action')!=='bulkconsume.asp'||f.attr('method')?.toLowerCase()!=='post'||required.some(name=>f.find(`[name="${name}"]`).length!==1)||f.find('[name]').toArray().some(e=>!required.includes($(e).attr('name')!)))throw new SafeError('Consumption form contract changed. No write submitted.');
    if(!f.find(`[name="iConsumptionType"] option[value="${details.type}"]`).length)throw new SafeError('Consumption reason is not supported by the live form.');
    const currency=String(f.find('[name="RevenueCurrency"]').val());if(!/^[A-Z]{3}$/.test(currency))throw new SafeError('Cannot read the consumption form currency.');
    return currency;
  }
  async consume(ids:string[],details:ConsumptionDetails,preparedCurrency?:string,expiresAt?:number){
    validateConsumption(details);
    const currency=preparedCurrency??await this.prepareConsumption(details);
    const response=await this.transport.request({kind:'consume',ids,details,currency,expiresAt});this.checkResponse(response.status,response.url);
    const xml=load(response.text,{xml:true});
    if(xml('error').text().trim()||/<!doctype html|<html[\s>]/i.test(response.text))throw new SafeError('Unexpected or rejected consumption response; reconcile with history.');
  }
  private checkResponse(status: number, url: string) {
    const parsed = new URL(url);
    if (status !== 200 || parsed.origin !== 'https://www.cellartracker.com' || /login/i.test(parsed.pathname)) throw new SafeError('CellarTracker rejected the request or requires sign-in. Renew the cloud session through the approved secure setup flow.');
  }
}
