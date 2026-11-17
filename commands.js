'use strict'
// Deterministic natural-language command parser. No AI involved: a fixed set of
// phrasings maps to a fixed set of actions. Anything else returns { action: 'unknown' }.

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16, twenty: 20, 'thirty two': 32, 'sixty four': 64 }

const COMMAND_HELP = [
  ['follow <player>', 'Follow a player (use "follow me" after setting your in-game name)'],
  ['come [player]', 'Walk to a player once'],
  ['stop', 'Stop the current task'],
  ['collect wood [count]', 'Chop the nearest trees and pick up the logs'],
  ['mine <block> [count]', 'Mine a block type, e.g. "mine 5 stone"'],
  ['craft <item> [count]', 'Craft planks, sticks, crafting table, tools...'],
  ['inventory', 'List what the bot is carrying'],
  ['say <message>', 'Send a chat message (also /commands)'],
  ['goto <x> <y> <z>', 'Walk to coordinates (y optional)'],
  ['jump', 'Jump once'],
  ['explore [radius]', 'Wander around until you say stop'],
  ['eat', 'Eat the best food in the inventory'],
  ['sleep', 'Sleep in a nearby bed (night only)'],
  ['equip <item>', 'Hold an item'],
  ['drop <item> [count]', 'Throw items on the ground'],
  ['status', 'Health, food, position'],
  ['players', 'Who is online'],
  ['yes / no', 'Answer the bot when it asks before using resources']
]

function parseCount (s) {
  if (s == null) return null
  s = String(s).trim().toLowerCase()
  if (/^\d+$/.test(s)) return Math.max(1, Math.min(Number(s), 2304))
  if (s in NUMBER_WORDS) return NUMBER_WORDS[s]
  return null
}

const FILLER = /\b(please|pls|plz|now|for me|bro|bot|can you|could you|would you|kindly|go and|some|the|thanks|thank you)\b/g

function clean (text) {
  return text
    .toLowerCase()
    .replace(/[!?.,;]+$/g, '')
    .replace(/[!?;]+/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Turns "4 oak planks" / "oak planks 4" / "four sticks" into { name, count }
function itemAndCount (s) {
  s = s.trim()
  let count = null
  let m = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|sixteen|twenty)\s+(.+)$/.exec(s)
  if (m) { count = parseCount(m[1]); s = m[2] } else {
    m = /^(.+?)\s+(?:x\s*)?(\d+)$/.exec(s)
    if (m) { count = parseCount(m[2]); s = m[1] }
  }
  s = s.replace(/^(of|some)\s+/, '').trim()
  return { name: s, count }
}

function parse (raw) {
  if (typeof raw !== 'string') return { action: 'unknown' }
  const original = raw.trim()
  if (!original) return { action: 'unknown' }

  // Raw chat commands go straight to the server: "/spawn", "/home"
  if (original.startsWith('/')) return { action: 'say', message: original }

  // say/chat keeps the user's own casing
  let m = /^(?:say|chat|send|tell everyone|type)\s*:?\s+(.+)$/i.exec(original)
  if (m) return { action: 'say', message: m[1] }

  const t = clean(original)
  if (!t) return { action: 'unknown' }

  if (/^(stop|halt|cancel|abort|freeze|stay|stand still|stop (it|that|everything|following|mining|collecting|exploring|moving))$/.test(t)) return { action: 'stop' }
  if (/^(yes|y|yeah|yep|ok|okay|sure|do it|confirm|go ahead)$/.test(t)) return { action: 'yes' }
  if (/^(no|n|nope|nah|don'?t|cancel that|never mind|nevermind)$/.test(t)) return { action: 'no' }
  if (/^(help|commands|what can you do|\?)$/.test(t)) return { action: 'help' }

  if (/^(inv|inventory|items|check (your )?inventory|show (me )?(your )?(inventory|items)|what(?:'s| is| do you have)? (in your inventory|you have|have you got)|what do you have)$/.test(t)) return { action: 'inventory' }
  if (/^(status|stats|health|hunger|food level|how are you|where are you|position|pos|coords|coordinates|location)$/.test(t)) return { action: 'status' }
  if (/^(players|who(?:'s| is) online|online players|list players|who is here|list)$/.test(t)) return { action: 'players' }

  if (/^(jump|hop)( once)?$/.test(t)) return { action: 'jump' }

  m = /^(?:explore|wander|roam|walk around|look around|scout)(?: (?:around|area))?(?: (?:radius|within|for)? ?(\d+)(?: blocks)?)?$/.exec(t)
  if (m) return { action: 'explore', radius: m[1] ? Math.min(Math.max(Number(m[1]), 8), 256) : 48 }

  m = /^(?:follow|track|chase)\s+(.+)$/.exec(t)
  if (m) return { action: 'follow', player: m[1].replace(/^player\s+/, '').trim() }

  m = /^(?:come(?: here| back)?|come to|go to|walk to|get over here)\s*(?:me)?\s*$/.exec(t)
  if (m) return { action: 'come', player: 'me' }
  m = /^(?:come to|go to|walk to|tp to|teleport to)\s+(?:player\s+)?([a-z0-9_ ]{1,16})$/.exec(t)
  if (m && !/^\-?\d/.test(m[1])) return { action: 'come', player: m[1].trim() }

  m = /^(?:go ?to|goto|walk to|move to|go)\s+(?:x\s*)?(-?\d+(?:\.\d+)?)[\s,]+(?:y\s*)?(-?\d+(?:\.\d+)?)(?:[\s,]+(?:z\s*)?(-?\d+(?:\.\d+)?))?$/.exec(t)
  if (m) {
    if (m[3] !== undefined) return { action: 'goto', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
    return { action: 'goto', x: Number(m[1]), z: Number(m[2]) }
  }

  // wood / logs
  m = /^(?:collect|get|gather|chop|cut|harvest|farm|grab|find)\s+(?:(\d+|a few|[a-z]+)\s+)?(?:wood|woods|logs?|trees?|timber)(?:\s+(\d+))?$/.exec(t)
  if (m) {
    const c = parseCount(m[1]) || parseCount(m[2])
    return { action: 'collect', what: 'wood', count: c || 4 }
  }
  m = /^(?:chop|cut)( down)? (?:a |some )?trees?$/.exec(t)
  if (m) return { action: 'collect', what: 'wood', count: 4 }

  m = /^(?:mine|dig|break|collect|gather|get|harvest)\s+(.+)$/.exec(t)
  if (m) {
    const { name, count } = itemAndCount(m[1])
    return { action: 'mine', block: name, count: count || 1 }
  }

  m = /^(?:craft|make|build|create)\s+(.+)$/.exec(t)
  if (m) {
    const { name, count } = itemAndCount(m[1])
    return { action: 'craft', item: name, count: count || 1 }
  }

  m = /^(?:equip|hold|wield|use)\s+(.+)$/.exec(t)
  if (m) return { action: 'equip', item: m[1] }

  m = /^(?:drop|toss|throw)\s+(?:all\s+)?(.+)$/.exec(t)
  if (m) {
    const { name, count } = itemAndCount(m[1])
    return { action: 'drop', item: name, count: /^(?:drop|toss|throw)\s+all\s/.test(t) ? null : count }
  }

  if (/^(eat|eat (something|food)|you(?:'re| are) hungry)$/.test(t)) return { action: 'eat' }
  if (/^(sleep|go to (sleep|bed)|use bed)$/.test(t)) return { action: 'sleep' }

  return { action: 'unknown' }
}

// Normalize an item/block phrase to registry-style candidates: "oak logs" -> ["oak_logs","oak_log"]
function registryCandidates (phrase) {
  const base = phrase.toLowerCase().trim().replace(/^minecraft:/, '').replace(/[^a-z0-9_ ]/g, '').replace(/\s+/g, '_')
  const out = [base]
  if (base.endsWith('ies')) out.push(base.slice(0, -3) + 'y')
  if (base.endsWith('es')) out.push(base.slice(0, -2))
  if (base.endsWith('s')) out.push(base.slice(0, -1))
  // "planks" on its own should stay plural (oak_planks), handled by callers
  return [...new Set(out)]
}

module.exports = { parse, COMMAND_HELP, registryCandidates, parseCount }
