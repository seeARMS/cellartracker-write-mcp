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
    if (request.kind==='inventory') {
      if (!Number.isInteger(request.page) || request.page<1 || request.page>500) throw new Error('Invalid page');
      return {path:'/list.asp?table=Inventory&Page='+request.page,method:'GET'};
    }
    if (request.kind==='relocationForm') return {path:'/popup/relocate_form.asp',method:'GET'};
    if (request.kind!=='relocate' || !Array.isArray(request.ids) || request.ids.length<1 || request.ids.length>50 || request.ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id)) || new Set(request.ids).size!==request.ids.length) throw new Error('Invalid relocation');
    const location=label(request.location), bin=label(request.bin);
    if(!location)throw new Error('Location is required');
    const query='searchId=&UISource=&SetLocation='+latin(location)+'&SetBin='+latin(bin)+(bin===''?'&Bin_delete=on':'');
    return {path:'/relocate.asp?'+query,method:'POST',body:'BulkAction=&'+request.ids.map(id=>'iInventory='+id).join('&')};
  }
  root.CellarTrackerProtocol={build};
})(globalThis);
