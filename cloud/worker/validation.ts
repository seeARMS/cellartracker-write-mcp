import {SafeError,type ConsumptionDetails} from './types.js';
export function validateConsumption(d:ConsumptionDetails){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(d.date)||Number.isNaN(Date.parse(d.date))||new Date(d.date).toISOString().slice(0,10)!==d.date)throw new SafeError('Use a valid absolute date in YYYY-MM-DD, resolved in the owner’s intended timezone.');
 if(d.type!==1)throw new SafeError('This cloud integration supports drank consumption only.');
 if(typeof d.note!=='string'||d.note.length>512||/[\x00-\x1f\x7f]/.test(d.note))throw new SafeError('Use a single-line consumption note of at most 512 characters.');
}
