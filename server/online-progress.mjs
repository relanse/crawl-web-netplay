import {DatabaseSync} from 'node:sqlite';
import {closeSync,mkdirSync,openSync} from 'node:fs';
import path from 'node:path';

export const guestLifetimeMs=365*24*60*60*1000;

const validAmount=value=>Number.isSafeInteger(value)&&value>=0&&value<=0x7fffffff;
const standingsOrder=new Map([
  ['overall','bossKills DESC,bestLevel DESC,heroKills DESC,completed DESC'],
  ['bossKills','bossKills DESC,CAST(bossKills AS REAL)/completed DESC,bestLevel DESC'],
  ['bestLevel','bestLevel DESC,xp DESC,bossKills DESC'],
  ['heroKills','heroKills DESC,bossKills DESC,completed DESC'],
  ['xp','xp DESC,bestLevel DESC,completed DESC']
]);
const matchPlayerColumns=`
  p.player_id AS playerId, p.slot, p.nickname, p.tag, p.level, p.xp,
  p.hero_kills AS heroKills, p.monster_kills AS monsterKills,
  p.boss_kill AS bossKill, p.abandoned
`;

export class OnlineProgress {
  constructor(directory){
    this.directory=path.resolve(directory);
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,'online.sqlite');
    closeSync(openSync(file,'a',0o600));
    this.db=new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY, digest TEXT UNIQUE, expires INTEGER NOT NULL,
        nickname TEXT, tag TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL, boss_defeated INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(match_id), player_id TEXT NOT NULL REFERENCES players(player_id),
        slot INTEGER NOT NULL, nickname TEXT NOT NULL, tag TEXT NOT NULL, level INTEGER NOT NULL,
        xp INTEGER NOT NULL, hero_kills INTEGER NOT NULL, monster_kills INTEGER NOT NULL,
        boss_kill INTEGER NOT NULL, abandoned INTEGER NOT NULL,
        PRIMARY KEY(match_id,slot), UNIQUE(match_id,player_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS player_history ON match_players(player_id);
      CREATE VIEW IF NOT EXISTS standings AS
        SELECT a.player_id AS playerId, a.nickname, a.tag,
          COUNT(*) AS completed, SUM(p.boss_kill) AS bossKills, MAX(p.level) AS bestLevel,
          SUM(p.xp) AS xp, SUM(p.hero_kills) AS heroKills, SUM(p.monster_kills) AS monsterKills
        FROM match_players p JOIN players a USING(player_id)
        WHERE p.abandoned=0 GROUP BY a.player_id;
    `);
  }

  findGuest(digest){
    return this.db.prepare('SELECT player_id AS playerId, digest, expires FROM players WHERE digest=?').get(digest);
  }

  saveGuest({playerId,digest,expires}){
    this.db.prepare(`
      INSERT INTO players (player_id,digest,expires) VALUES (?,?,?)
      ON CONFLICT(player_id) DO UPDATE SET digest=excluded.digest, expires=excluded.expires
    `).run(playerId,digest,expires);
  }

  deleteGuest(playerId){
    this.db.prepare('UPDATE players SET digest=NULL, expires=0 WHERE player_id=?').run(playerId);
  }

  display(playerId){
    return this.db.prepare('SELECT nickname,tag FROM players WHERE player_id=? AND nickname IS NOT NULL').get(playerId);
  }

  saveDisplay(playerId,{nickname,tag}){
    this.db.prepare('UPDATE players SET nickname=?,tag=? WHERE player_id=?').run(nickname,tag,playerId);
  }

  recordMatch(matchId,roster,result){
    if(result?.completed!==true||typeof result.bossDefeated!=='boolean'||!validAmount(result.durationSeconds)||
      !Number.isInteger(result.winnerSlot)||result.winnerSlot< -1||
      !Array.isArray(result.players)||result.players.length!==roster.length)throw Error('RESULT_INVALID');
    const slots=new Map(result.players.map(p=>[p?.slot,p]));
    const winner=slots.get(result.winnerSlot);
    if(slots.size!==roster.length||(result.winnerSlot!==-1&&(!result.bossDefeated||!winner||winner.abandoned)))throw Error('RESULT_INVALID');
    const players=roster.map(m=>{
      const row=slots.get(m.slot);
      if(!row||typeof row.abandoned!=='boolean'||![row.level,row.xp,row.heroKills,row.monsterKills].every(validAmount)||
        (!row.abandoned&&row.level<1))throw Error('RESULT_INVALID');
      return {...row,playerId:m.playerId,nickname:m.nickname,tag:m.tag,bossKill:result.winnerSlot===m.slot};
    });
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const inserted=this.db.prepare('INSERT INTO matches VALUES (?,?,?,?) ON CONFLICT(match_id) DO NOTHING')
        .run(matchId,Date.now(),result.durationSeconds,Number(result.bossDefeated));
      if(inserted.changes){
        const add=this.db.prepare('INSERT INTO match_players VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        const name=this.db.prepare('UPDATE players SET nickname=?,tag=? WHERE player_id=? AND nickname IS NULL');
        for(const player of players){
          name.run(player.nickname,player.tag,player.playerId);
          add.run(matchId,player.playerId,player.slot,player.nickname,player.tag,player.level,player.xp,
            player.heroKills,player.monsterKills,Number(player.bossKill),Number(player.abandoned));
        }
      }
      this.db.exec('COMMIT');
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
    const match=this.db.prepare(`
      SELECT match_id AS matchId, completed_at AS completedAt, duration_seconds AS durationSeconds,
        boss_defeated AS bossDefeated FROM matches WHERE match_id=?
    `).get(matchId);
    match.players=this.db.prepare(`
      SELECT ${matchPlayerColumns} FROM match_players p WHERE p.match_id=? ORDER BY p.slot
    `).all(matchId);
    return match;
  }

  overview(playerId,sort='overall'){
    const order=standingsOrder.get(sort);
    if(!order)throw Error('INVALID_STANDINGS_SORT');
    const self=this.db.prepare('SELECT * FROM standings WHERE playerId=?').get(playerId)??null;
    const leaderboard=this.db.prepare(`
      SELECT * FROM standings ORDER BY ${order},playerId LIMIT 20
    `).all();
    const recent=this.db.prepare(`
      SELECT m.match_id AS matchId, m.completed_at AS completedAt, m.duration_seconds AS durationSeconds,
        m.boss_defeated AS bossDefeated,${matchPlayerColumns}
      FROM match_players p JOIN matches m USING(match_id)
      WHERE p.player_id=? ORDER BY m.completed_at DESC,m.match_id DESC LIMIT 10
    `).all(playerId);
    return {self,leaderboard,recent};
  }

  close(){this.db.close();}
}
