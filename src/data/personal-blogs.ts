export interface PersonalBlogPerson {
    slug: 'omar' | 'layla' | 'youssef';
    collection: 'omar' | 'layla' | 'youssef';
    nameAr: string;
    nameLatin: string;
    tagline: string;
    bio: string;
    accent: string;
}

export const PERSONAL_COLLECTIONS = ['omar', 'layla', 'youssef'] as const;

export const personalBlogs: Record<string, PersonalBlogPerson> = {
    omar: {
        slug: 'omar',
        collection: 'omar',
        nameAr: 'عمر الحربي',
        nameLatin: 'OMAR AL-HARBI',
        tagline: 'هندسة البرمجيات · الذكاء الاصطناعي',
        bio: 'مهندس برمجيات ومهتم بالذكاء الاصطناعي. أكتب عن المصادر المفتوحة، الأمن السيبراني، والشركات الناشئة التقنية، وأحاول المساهمة في إثراء المحتوى التقني العربي.',
        accent: '#2563eb',
    },
    layla: {
        slug: 'layla',
        collection: 'layla',
        nameAr: 'ليلى المنصوري',
        nameLatin: 'LAYLA AL-MANSOURI',
        tagline: 'العلوم البيئية · الاستدامة',
        bio: 'باحثة في العلوم البيئية، مهتمة بالاستدامة والطاقة المتجددة والنظم البيئية الصحراوية. أوثّق ملاحظاتي بالكاميرا كما أوثقها بالكلمات.',
        accent: '#16a34a',
    },
    youssef: {
        slug: 'youssef',
        collection: 'youssef',
        nameAr: 'يوسف الخطيب',
        nameLatin: 'YOUSSEF EL-KHATIB',
        tagline: 'الاقتصاد · السياسات العامة',
        bio: 'باحث في الاقتصاد والسياسات العامة، مهتم بقضايا التنمية الاقتصادية وريادة الأعمال، وأقرأ في التاريخ والأدب العربي بقدر ما أقرأ في التقارير الاقتصادية.',
        accent: '#b45309',
    },
};
