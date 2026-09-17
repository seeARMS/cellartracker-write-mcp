// Shared pure request builder. No arbitrary URLs, scripts, headers, or methods.
(function (root) {
  function label(value) {
    if (typeof value !== 'string' || value.length > 40 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value) || value === '(use current)') throw new Error('Invalid label');
    return value;
  }
  // Matches the observed website's serializeLatin/escapeComponent encoding.
  function latin(value) {
    let result = '';
    for (let index=0; index<value.length; index++) {
      const code=value.charCodeAt(index);
      result += code > 255 && code !== 381 ? '&#'+code+';' : value[index];
    }
    return escape(result).replace(/\+/g,'%2B').replace(/%20/g,'+');
  }
  function build(request) {
    if (!request || typeof request !== 'object') throw new Error('Invalid request');
    if(request.kind==='searchWines'){
      if(typeof request.query!=='string'||!request.query.trim()||request.query.length>200||!Number.isInteger(request.page)||request.page<1||request.page>500)throw new Error('Invalid search');
      return {path:'/list.asp?Table=List&iUserOverride=0&fInStock=0&szSearch='+encodeURIComponent(request.query)+'&Page='+request.page,method:'GET'};
    }
    if(request.kind==='creationForm'){
      if(typeof request.wineId!=='string'||!/^\d+$/.test(request.wineId))throw new Error('Invalid wine ID');
      return {path:'/purchase.asp?iWine='+request.wineId,method:'GET'};
    }
    if(request.kind==='createBottles'){
      const d=request.details;
      if(!d||typeof d.wineId!=='string'||!/^\d+$/.test(d.wineId)||BigInt(d.wineId)<1n||!Number.isInteger(d.quantity)||d.quantity<1||d.quantity>240||typeof d.size!=='string'||!/^\d+(?:\.\d+)?(?:ml|L|oz)$/.test(d.size)||typeof request.currency!=='string'||!/^[A-Z]{3}$/.test(request.currency))throw new Error('Invalid creation');
      label(d.location);label(d.bin);if(!d.location)throw new Error('Location is required');
      const fields={iWine:d.wineId,Action:'Add',BinUI:'Bulk',Quantity:String(d.quantity),Size:d.size,DeliveryState:'delivered',Location:d.location,Bin:d.bin,BottleNote:'',StoreName:'',PurchaseDate:'',DeliveryDate:'',BottleCostCurrency:request.currency,BottleCost:'',PurchaseNote:''};
      return {path:'/purchase.asp',method:'POST',body:Object.entries(fields).map(([key,value])=>key+'='+latin(value)).join('&')};
    }
    if (request.kind==='inventory'||request.kind==='consumed') {
      if (!Number.isInteger(request.page) || request.page<1 || request.page>500) throw new Error('Invalid page');
      return {path:'/list.asp?table='+(request.kind==='inventory'?'Inventory':'Consumed')+'&Page='+request.page,method:'GET'};
    }
    if (request.kind==='relocationForm') return {path:'/popup/relocate_form.asp',method:'GET'};
    if(request.kind==='consumptionForm')return {path:'/popup/consume_form.asp',method:'GET'};
    if(request.kind==='consumptionDetails'){
      if(typeof request.wineId!=='string'||typeof request.consumedId!=='string'||!/^\d+$/.test(request.wineId)||!/^\d+$/.test(request.consumedId))throw new Error('Invalid consumption identifiers');
      return {path:'/editconsumed.asp?iWine='+request.wineId+'&iConsumed='+request.consumedId,method:'GET'};
    }
    if ((request.kind!=='relocate' && request.kind!=='consume') || !Array.isArray(request.ids) || request.ids.length<1 || request.ids.length>50 || request.ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id)) || new Set(request.ids).size!==request.ids.length) throw new Error('Invalid relocation');
    if(request.kind==='consume'){
      const d=request.details;
      if(!d||typeof d.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d.date)||Number.isNaN(Date.parse(d.date))||new Date(d.date).toISOString().slice(0,10)!==d.date||!Number.isInteger(d.type)||d.type<1||d.type>14||typeof d.note!=='string'||d.note.length>512||/[\x00-\x1f\x7f]/.test(d.note)||typeof request.currency!=='string'||!/^[A-Z]{3}$/.test(request.currency))throw new Error('Invalid consumption');
      const [year,month,day]=d.date.split('-');
      return {path:'/bulkconsume.asp?Consumed='+Number(month)+'%2F'+Number(day)+'%2F'+year+'&iConsumptionType='+d.type+'&ConsumptionNote='+latin(d.note)+'&Revenue=&RevenueCurrency='+request.currency,method:'POST',body:'BulkAction=&'+request.ids.map(id=>'iInventory='+id).join('&')};
    }
    const location=label(request.location), bin=label(request.bin);
    if(!location)throw new Error('Location is required');
    const query='searchId=&UISource=&SetLocation='+latin(location)+'&SetBin='+latin(bin)+(bin===''?'&Bin_delete=on':'');
    return {path:'/relocate.asp?'+query,method:'POST',body:'BulkAction=&'+request.ids.map(id=>'iInventory='+id).join('&')};
  }
  root.CellarTrackerProtocol={build};
})(globalThis);
