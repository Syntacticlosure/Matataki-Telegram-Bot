import { inject } from "inversify";
import { Extra, Markup } from "telegraf";
import { User as TelegramUser } from "telegraf/typings/telegram-types";

import { Controller, Command, InjectRepository, Event } from "#/decorators";
import { MessageHandlerContext } from "#/definitions";
import { Group, User } from "#/entities";
import { Injections, LogCategories } from "#/constants";
import { IUserRepository, IGroupRepository } from "#/repositories";
import { IBotService, IMatatakiService, IWeb3Service, ILoggerService } from "#/services";

import { BaseController } from ".";

@Controller("group")
export class GroupController extends BaseController<GroupController> {
    constructor(
        @InjectRepository(User) private userRepo: IUserRepository,
        @InjectRepository(Group) private groupRepo: IGroupRepository,
        @inject(Injections.BotService) private botService: IBotService,
        @inject(Injections.Web3Service) private web3Service: IWeb3Service,
        @inject(Injections.LoggerService) private loggerService: ILoggerService,
        @inject(Injections.MatatakiService) private matatakiService: IMatatakiService) {
        super();
    }

    @Command("mygroups", { ignorePrefix: true })
    async listMyGroups({ message, reply, telegram }: MessageHandlerContext) {
        const sender = message.from.id;

        const info = await this.matatakiService.getAssociatedInfo(sender);
        if (!info.user || !info.minetoken) {
            await reply("抱歉，你没有在 瞬Matataki 绑定该 Telegram 帐号或者尚未发行 Fan 票");
            return;
        }

        const groups = await this.groupRepo.getGroupsOfCreator(sender);

        if (groups.length === 0) {
            await reply(`抱歉，你还没有创建 Fan票 群`);
            return;
        }

        const groupNames = new Map<Group, string>();

        await Promise.all(groups.map(async group => {
            const info = await telegram.getChat(group.id);
            if (!info.title) {
                throw new Error("What happened?");
            }

            groupNames.set(group, info.title);
        }));

        let isFirst = true;
        for (const group of groups) {
            if (!isFirst) {
                console.log("=====================");
            }

            await reply(`群组 ID：${group.id}
名字：${groupNames.get(group)}
Fan 票：${info.minetoken?.symbol}
最低要求${group.requirement.minetoken?.amount ?? 0}`);

            isFirst = false;
        }
    }

    @Command("set", { ignorePrefix: true })
    async setGroupRequirement({ message, reply, telegram }: MessageHandlerContext) {
        const sender = message.from.id;
        const info = await this.matatakiService.getAssociatedInfo(sender);
        if (!info.user || !info.minetoken) {
            await reply("抱歉，你没有在 瞬Matataki 绑定该 Telegram 帐号或者尚未发行 Fan 票");
            return;
        }

        const match = /^\/set (-?\d+) (\d+)$/.exec(message.text);
        if (!match || match.length < 2) {
            return reply("格式不对，请输入 `/set group_id amount`");
        }

        const groupId = Number(match[1]);
        const groups = await this.groupRepo.getGroupsOfCreator(sender);
        const group = groups.find(group => Number(group.id) === groupId);

        if (!group) {
            await reply(`没有找到该群`);
            return;
        }

        const administrators = await telegram.getChatAdministrators(groupId);
        const me = administrators.find(admin => admin.user.id === this.botService.info.id);
        if (!me || !me.can_invite_users) {
            await reply("请把机器人设置为管理员并设置邀请用户权限");
            return;
        }

        const amount = Number(match[2]);
        await this.groupRepo.setRequirement(group, amount);

        await reply("OK");
        return true;
    }

    @Command("join", { ignorePrefix: true })
    async joinGroup({ message, reply, telegram }: MessageHandlerContext) {
        const sender = message.from.id;
        const info = await this.matatakiService.getAssociatedInfo(sender);
        if (!info.user) {
            await reply("抱歉，你没有在 瞬Matataki 绑定该 Telegram 帐号");
            return;
        }

        const walletAddress = await this.matatakiService.getEthWallet(sender);;

        const balanceCache = new Map<number, number>();
        const contractAddressCache = new Map<number, string>();

        const groups = await this.groupRepo.getGroupsExceptMyToken(info.minetoken?.id);
        await Promise.all(groups.map(async group => {
            let balance = balanceCache.get(group.tokenId);
            if (typeof balance === "number") {
                return;
            }

            let contractAddress = contractAddressCache.get(group.tokenId);
            if (!contractAddress) {
                contractAddress = await this.matatakiService.getContractAddressOfMinetoken(group.tokenId);
                contractAddressCache.set(group.tokenId, contractAddress);
            }

            balance = await this.web3Service.getBalance(contractAddress, walletAddress);
            balanceCache.set(group.tokenId, balance!);
        }));
        const acceptableGroups = groups.filter(group => (balanceCache.get(group.tokenId) ?? -1) >= (group.requirement.minetoken?.amount ?? 0));
        if (acceptableGroups.length === 0) {
            await reply("抱歉，你持有的 Fan票 不满足任何一个群的条件");
            return;
        }

        const buttons = await Promise.all(acceptableGroups.map(async group => {
            const groupId = Number(group.id);
            const info = await telegram.getChat(groupId);
            if (!info.title) {
                throw new Error("What happened?");
            }

            const cm = await telegram.getChatMember(groupId, sender);
            if (cm.status === "kicked") {
                // @ts-ignore
                await telegram.unbanChatMember(groupId, sender);
            }

            return Markup.urlButton(info.title, info.invite_link ?? await telegram.exportChatInviteLink(groupId));
        }));

        await reply("你现在可以进入以下的群：", Markup.inlineKeyboard([
            buttons
        ]).extra());
    }

    @Event("new_chat_members")
    async onNewMemberEnter({ message, reply, telegram }: MessageHandlerContext) {
        if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
            console.log("Not support private and channel");
            return;
        }

        let group: Group;

        const groupId = message.chat.id;
        const groupInfo = await telegram.getChat(groupId);
        const groupName = groupInfo.title;

        const inviterId = message.from.id;

        let newMembers = message.new_chat_members ?? [];
        const me = newMembers.find(member => member.id === this.botService.info.id);
        if (!me) {
            group = await this.groupRepo.getGroup(groupId);
        } else {
            const administrators = await telegram.getChatAdministrators(groupId);
            const creator = administrators.find(admin => admin.status === "creator");
            if (!creator) {
                throw new Error("Impossible situation");
            }

            const creatorId = creator.user.id;
            if (inviterId !== creatorId) {
                await reply("邀请者不是群主，立即退出");
                await telegram.leaveChat(groupId);
                return;
            }

            const info = await this.matatakiService.getAssociatedInfo(inviterId);
            if (!info.user || !info.minetoken) {
                await reply("群主没有在 瞬Matataki 绑定该 Telegram 帐号或者尚未发行 Fan 票，立即退出");
                await telegram.leaveChat(groupId);
                return;
            }

            group = await this.groupRepo.ensureGroup(groupId, groupName ?? "", creator.user.id, info.minetoken.id);

            await this.botService.sendMessage(creatorId, `你已把机器人拉进群 **${groupName}**。为了机器人的正常工作，请把机器人设置为管理员并取消群员拉人权限`);

            if (groupInfo.type === "group") {
                await this.botService.sendMessage(creatorId, `**${groupName}** 现在是一个小群，对于机器人的正常工作存在一定影响，建议采取一些操作升级到大群。包括但不限于以下操作：
- 临时转公开并设置群链接
- 修改任意管理员操作权限`);
            }
        }

        const acceptedUsers = new Set<TelegramUser>();

        for (const member of newMembers) {
            if (member.is_bot) {
                continue;
            }

            const contractAddress = await this.matatakiService.getContractAddressOfMinetoken(group.tokenId);
            const requirement = group.requirement.minetoken?.amount ?? 0;

            let walletAddress: string;
            try {
                walletAddress = await this.matatakiService.getEthWallet(member.id);
            } catch (e) {
                try {
                    await this.botService.kickMember(groupId, member.id);
                    await this.botService.sendMessage(member.id, `抱歉，你现在没有绑定 瞬Matataki，现已被移出`);
                } catch (e) {
                    this.loggerService.warn(LogCategories.TelegramUpdate, e);
                }
                continue;
            }

            const balance = await this.web3Service.getBalance(contractAddress, walletAddress);

            if (balance >= requirement) {
                acceptedUsers.add(member);
                continue;
            }

            try {
                await this.botService.kickMember(groupId, member.id);
                await this.botService.sendMessage(member.id, `抱歉，你现在的 Fan 票不满足群 ${groupName} 的条件，现已被移出`);
            } catch (e) {
                this.loggerService.warn(LogCategories.TelegramUpdate, e);
            }
        }

        if (acceptedUsers.size === 0) {
            return;
        }

        const members = await Promise.all(Array.from(acceptedUsers).map(member => this.userRepo.ensureUser(member.id)));

        await this.groupRepo.addMembers(group, members);
    }

    @Event("left_chat_member")
    async onMemberLeft({ message, telegram }: MessageHandlerContext) {
        if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
            console.log("Not support private and channel");
            return;
        }

        const member = message.left_chat_member;
        if (!member) {
            throw new Error("What happened?");
        }

        const groupId = message.chat.id;
        const group = await this.groupRepo.getGroup(groupId);

        if (member.is_bot && member.id === this.botService.info.id) {

            await this.groupRepo.setActive(group, false);
            return;
        }

        const user = group.members.find(user => Number(user.id) === member.id);
        if (!user) {
            console.log(`The user ${member.id} (${member.username}) is not in group ${groupId} (${message.chat.title})`);
            return;
        }

        await this.groupRepo.removeMember(group, user);
    }

    @Event(["group_chat_created", "supergroup_chat_created"])
    async onGroupCreated({ message, reply, telegram }: MessageHandlerContext) {
        const { id: groupId, title } = message.chat;
        const inviterId = message.from.id;

        const info = await this.matatakiService.getAssociatedInfo(inviterId);
        if (!info.user || !info.minetoken) {
            await reply("群主没有在 瞬Matataki 绑定该 Telegram 帐号或者尚未发行 Fan 票，立即退出");
            await telegram.leaveChat(groupId);
            return;
        }

        await this.groupRepo.ensureGroup(groupId, title ?? "", inviterId, info.minetoken.id);
    }
    @Event("migrate_to_chat_id")
    async onGroupMigration({ message }: MessageHandlerContext) {
        if (!message.migrate_to_chat_id) {
            throw new Error("Impossible situation");
        }

        const group = await this.groupRepo.getGroup(message.chat.id);

        await this.groupRepo.changeGroupId(group, message.migrate_to_chat_id);
    }

    @Event("new_chat_title")
    async onGroupTitleChanged({ message }: MessageHandlerContext) {
        if (!message.new_chat_title) {
            throw new Error("Impossible situation");
        }

        const group = await this.groupRepo.getGroup(message.chat.id);

        await this.groupRepo.changeGroupTitle(group, message.new_chat_title);
    }

    async joinGroupWithStartPayload({ reply, message, telegram }: MessageHandlerContext, groupId: number): Promise<boolean> {
        let group: Group;
        try {
            group = await this.groupRepo.getGroup(groupId);
        } catch (e) {
            this.loggerService.error(LogCategories.TelegramUpdate, "GroupId not found", groupId);
            return false;
        }

        const sender = message.from.id;

        if (sender === Number(group.creatorId)) {
            const button = Markup.urlButton(group.title, await telegram.exportChatInviteLink(groupId));

            await reply("你是该群群主：", Markup.inlineKeyboard([button]).extra());
            return true;
        }

        const info = await this.matatakiService.getAssociatedInfo(sender);
        if (!info.user) {
            await reply("抱歉，你没有在 瞬Matataki 绑定该 Telegram 帐号");
            return true;
        }

        const groupRequirement = group.requirement.minetoken?.amount ?? 0;

        const walletAddress = await this.matatakiService.getEthWallet(sender);;
        const contractAddress = await this.matatakiService.getContractAddressOfMinetoken(group.tokenId);
        const balance = await this.web3Service.getBalance(contractAddress, walletAddress);

        const { minetoken } = await this.matatakiService.getAssociatedInfo(Number(group.creatorId));

        if (!minetoken) {
            throw new Error("Impossible situation");
        }

        if (balance < groupRequirement) {
            await reply(`抱歉，你持有的 Fan票 不满足群 ${group.title} 的条件：
要求 ${minetoken.name}(${minetoken.symbol}) >= ${groupRequirement}`);
            return true;
        }

        const chatMember = await telegram.getChatMember(groupId, sender);
        if (chatMember.status === "member") {
            const button = Markup.urlButton(group.title, await telegram.exportChatInviteLink(groupId));

            await reply("你已经是该 Fan票 群群员：", Markup.inlineKeyboard([button]).extra());
            return true;
        }

        if (chatMember.status === "kicked") {
            // @ts-ignore
            await telegram.unbanChatMember(groupId, sender);
        }

        const button = Markup.urlButton(group.title, await telegram.exportChatInviteLink(groupId));

        await reply("你现在可以进入该群：：", Markup.inlineKeyboard([button]).extra());
        return true;
    }
}
