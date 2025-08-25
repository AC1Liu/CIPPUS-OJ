import * as TypeORM from "typeorm";
import Model from "./common";

declare var syzoj, ErrorMessage: any;

import User from "./user";
import File from "./file";
import Problem from "./problem";
import ContestRanklist from "./contest_ranklist";
import ContestPlayer from "./contest_player";

import * as fs from "fs-extra";
import * as path from "path";
import * as util from "util";
import * as LRUCache from "lru-cache";
import * as DeepCopy from "deepcopy";

enum ContestType {
  NOI = "noi",
  IOI = "ioi",
  ICPC = "acm"
}

@TypeORM.Entity()
export default class Contest extends Model {
  static cache = true;

  @TypeORM.PrimaryGeneratedColumn()
  id: number;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  title: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  subtitle: string;

  @TypeORM.Column({ nullable: true, type: "integer" })
  start_time: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  rank_stop_time: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  end_time: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  holder_id: number;

  // type: noi, ioi, acm
  @TypeORM.Column({ nullable: true, type: "enum", enum: ContestType })
  type: ContestType;

  @TypeORM.Column({ nullable: true, type: "text" })
  information: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  after_information: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  problems: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  admins: string;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  ranklist_id: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  masked_ranklist_id: number;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_public: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  show_statistics: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  allow_seeing_others: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  allow_seeing_solution: boolean;

  @TypeORM.Column({ nullable: true, type: "text" })
  password: string;

  holder?: User;
  ranklist?: ContestRanklist;
  masked_ranklist?: ContestRanklist;

  async loadRelationships() {
    this.holder = await User.findById(this.holder_id);
    this.ranklist = await ContestRanklist.findById(this.ranklist_id);
    this.masked_ranklist = await ContestRanklist.findById(this.masked_ranklist_id);
  }

  async isSupervisior(user) {
    return user && (user.is_admin || this.holder_id === user.id || this.admins.split('|').includes(user.id.toString()));
  }

  allowedSeeingOthers() {
    if (this.type === 'acm' && this.allow_seeing_others) return true;
    else return false;
  }

  allowedSeeingScore() { // If not, then the user can only see status
    if (this.type === 'ioi') return true;
    else return false;
  }

  allowedSeeingResult() { // If not, then the user can only see compile progress
    if (this.type === 'ioi' || this.type === 'acm') return true;
    else return false;
  }

  allowedSeeingTestcase() {
    if (this.type === 'ioi') return true;
    return false;
  }

  async getProblems() {
    if (!this.problems) return [];
    return this.problems.split('|').map(x => parseInt(x));
  }

  async setProblemsNoCheck(problemIDs) {
    this.problems = problemIDs.join('|');
  }

  async setProblems(s) {
    let a = [];
    await s.split('|').forEachAsync(async x => {
      let problem = await Problem.findById(x);
      if (!problem) return;
      a.push(x);
    });
    this.problems = a.join('|');
  }

  async newSubmission(judge_state) {
    if (!(judge_state.submit_time >= this.start_time && judge_state.submit_time <= this.end_time)) {
      return;
    }
    let problems = await this.getProblems();
    if (!problems.includes(judge_state.problem_id)) throw new ErrorMessage('当前比赛中无此题目。');

    await syzoj.utils.lock(['Contest::newSubmission', judge_state.user_id], async () => {
      let player = await ContestPlayer.findInContest({
        contest_id: this.id,
        user_id: judge_state.user_id
      });

      if (!player) {
        player = await ContestPlayer.create({
          contest_id: this.id,
          user_id: judge_state.user_id
        });
        await player.save();
      }

      await this.loadRelationships();

      if (!this.masked_ranklist) {
        this.masked_ranklist = await ContestRanklist.create();
        this.masked_ranklist.ranking_params = this.ranklist.ranking_params;
        await this.masked_ranklist.save();
        this.masked_ranklist_id = this.masked_ranklist.id;
        await this.save();
      }

      await player.updateScore(judge_state);
      await player.save();
      await this.ranklist.updatePlayer(this, player, 0);
      await this.ranklist.save();

      await this.masked_ranklist.updatePlayer(this, player, 1);
      await this.masked_ranklist.save();
    });
  }

  isRunning(now?) {
    if (!now) now = syzoj.utils.getCurrentDate();
    return now >= this.start_time && now < this.end_time;
  }

  isEnded(now?) {
    if (!now) now = syzoj.utils.getCurrentDate();
    return now >= this.end_time;
  }

  getDownfilePath() {
    return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'downfile', this.id.toString());
  }

  getDownfileArchivePath() {
    return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'downfile-archive', this.id.toString() + '_down.zip');
  }

  async uploadDownfileSingleFile(filename, filepath, size, noLimit) {
    await syzoj.utils.lock(['Promise::Downfile', this.id], async () => {
      let dir = this.getDownfilePath();
      await fs.ensureDir(dir);

      let oldSize = 0, list = await this.listDownfile(), replace = false, oldCount = 0;
      if (list) {
        oldCount = list.files.length;
        for (let file of list.files) {
          if (file.filename !== filename) oldSize += file.size;
          else replace = true;
        }
      }

      if (!noLimit && oldSize + size > syzoj.config.limit.testdata) throw new ErrorMessage('数据包太大。');
      if (!noLimit && oldCount + (!replace as any as number) > syzoj.config.limit.testdata_filecount) throw new ErrorMessage('数据包中的文件太多。');

      await fs.move(filepath, path.join(dir, filename), { overwrite: true });

      let execFileAsync = util.promisify(require('child_process').execFile);
      try { await execFileAsync('dos2unix', [path.join(dir, filename)]); } catch (e) {}

      await fs.remove(this.getDownfileArchivePath());
    });
  }

  async deleteDownfileSingleFile(filename) {
    await syzoj.utils.lock(['Promise::Downfile', this.id], async () => {
      await fs.remove(path.join(this.getDownfilePath(), filename));
      await fs.remove(this.getDownfileArchivePath());
    });
  }

  async makeDownfileZip() {
    await syzoj.utils.lock(['Promise::Downfile', this.id], async () => {
      let dir = this.getDownfilePath();
      if (!await syzoj.utils.isDir(dir)) throw new ErrorMessage('无测试数据。');

      let p7zip = new (require('node-7z'));

      let list = await this.listDownfile(), pathlist = list.files.map(file => path.join(dir, file.filename));
      if (!pathlist.length) throw new ErrorMessage('无测试数据。');
      await fs.ensureDir(path.resolve(this.getDownfileArchivePath(), '..'));
      await p7zip.add(this.getDownfileArchivePath(), pathlist);
    });
  }

  async listDownfile() {
    try {
      let dir = this.getDownfilePath();
      let filenameList = await fs.readdir(dir);
      let list = await Promise.all(filenameList.map(async x => {
        let stat = await fs.stat(path.join(dir, x));
        if (!stat.isFile()) return undefined;
        return {
          filename: x,
          size: stat.size
        };
      }));

      list = list.filter(x => x);

      let res = {
        files: list,
        zip: null
      };

      try {
        let stat = await fs.stat(this.getDownfileArchivePath());
        if (stat.isFile()) {
          res.zip = {
            size: stat.size
          };
        }
      } catch (e) {
        if (list) {
          res.zip = {
            size: null
          };
        }
      }

      return res;
    } catch (e) {
      return null;
    }
  }

  getSolutionPath() {
    return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'solution', this.id.toString());
  }

  getSolutionArchivePath() {
    return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'solution-archive', this.id.toString() + '_sol.zip');
  }

  async uploadSolutionSingleFile(filename, filepath, size, noLimit) {
    await syzoj.utils.lock(['Promise::Solution', this.id], async () => {
      let dir = this.getSolutionPath();
      await fs.ensureDir(dir);
      let oldSize = 0, list = await this.listSolution(), replace = false, oldCount = 0;
      if (list) {
        oldCount = list.files.length;
        for (let file of list.files) {
          if (file.filename !== filename) oldSize += file.size;
          else replace = true;
        }
      }

      if (!noLimit && oldSize + size > syzoj.config.limit.testdata) throw new ErrorMessage('数据包太大。');
      if (!noLimit && oldCount + (!replace as any as number) > syzoj.config.limit.testdata_filecount) throw new ErrorMessage('数据包中的文件太多。');

      await fs.move(filepath, path.join(dir, filename), { overwrite: true });

      let execFileAsync = util.promisify(require('child_process').execFile);
      try { await execFileAsync('dos2unix', [path.join(dir, filename)]); } catch (e) {}

      await fs.remove(this.getSolutionArchivePath());
    });
  }

  async deleteSolutionSingleFile(filename) {
    await syzoj.utils.lock(['Promise::Solution', this.id], async () => {
      await fs.remove(path.join(this.getSolutionPath(), filename));
      await fs.remove(this.getSolutionArchivePath());
    });
  }

  async makeSolutionZip() {
    await syzoj.utils.lock(['Promise::Solution', this.id], async () => {
      let dir = this.getSolutionPath();
      if (!await syzoj.utils.isDir(dir)) throw new ErrorMessage('无测试数据。');

      let p7zip = new (require('node-7z'));

      let list = await this.listSolution(), pathlist = list.files.map(file => path.join(dir, file.filename));
      if (!pathlist.length) throw new ErrorMessage('无测试数据。');
      await fs.ensureDir(path.resolve(this.getSolutionArchivePath(), '..'));
      await p7zip.add(this.getSolutionArchivePath(), pathlist);
    });
  }

  async listSolution() {
    try {
      let dir = this.getSolutionPath();
      let filenameList = await fs.readdir(dir);
      let list = await Promise.all(filenameList.map(async x => {
        let stat = await fs.stat(path.join(dir, x));
        if (!stat.isFile()) return undefined;
        return {
          filename: x,
          size: stat.size
        };
      }));

      list = list.filter(x => x);

      let res = {
        files: list,
        zip: null
      };

      try {
        let stat = await fs.stat(this.getSolutionArchivePath());
        if (stat.isFile()) {
          res.zip = {
            size: stat.size
          };
        }
      } catch (e) {
        if (list) {
          res.zip = {
            size: null
          };
        }
      }

      return res;
    } catch (e) {
      return null;
    }
  }

  async updateFile(path, type, noLimit) {
    let file = await File.upload(path, type, noLimit);
    await this.save();
  }

}
